import { withAbort } from './cancellation';
import { normalizeBaseUrl } from './endpoint';
import { isProviderError, normalizeThrownError } from './errors';
import { listProviderModels } from './modelDiscovery';
import { credentialRequiredForProfile, getProviderProfile } from './profiles';
import { createProvider } from './registry';
import type { CancellationTokenLike } from './types';

export type FetchLike = typeof fetch;

export type ConnectionTestCode =
  | 'success'
  | 'authentication_failed'
  | 'network_error'
  | 'model_not_found'
  | 'endpoint_error'
  | 'configuration_error'
  | 'server_error'
  | 'unknown_error';

export interface ConnectionTestResult {
  readonly profileId: string;
  readonly displayName: string;
  readonly endpointHost: string;
  /** Endpoint answered over the network (TCP/TLS reachable). */
  readonly reachable: boolean;
  /** Credentials were accepted when required. */
  readonly authenticated: boolean;
  /** The configured model completed a minimal request. */
  readonly modelAvailable: boolean;
  /** Model-discovery endpoint returned a list. Distinct from `modelAvailable`. */
  readonly discoveryAvailable: boolean;
  readonly code: ConnectionTestCode;
  /** Safe diagnostic message. Never contains the API key. */
  readonly message: string;
  readonly discoveredModels?: readonly string[];
  readonly httpStatus?: number;
}

export interface ConnectionTestOptions {
  readonly type: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly allowInsecureLocalhost?: boolean;
  readonly token?: CancellationTokenLike;
}

/**
 * Tests connectivity for the selected profile without sending workspace
 * content. Only a minimal `Hello` prompt (≤5 output tokens) is sent.
 * Discovery and completion are reported separately — a reachable endpoint
 * does not imply model discovery will succeed.
 */
export async function testProviderConnection(
  options: ConnectionTestOptions,
): Promise<ConnectionTestResult> {
  const type = options.type.trim();
  const profile = getProviderProfile(type);
  const displayName = profile?.displayName ?? type;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const allowInsecureLocalhost = options.allowInsecureLocalhost ?? true;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      profileId: type,
      displayName,
      endpointHost: 'invalid endpoint',
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      discoveryAvailable: false,
      code: 'configuration_error',
      message: 'The connection test timeout must be a positive number.',
    };
  }

  // Endpoint validation (Gemini uses a fixed host).
  let endpointHost = 'invalid endpoint';
  let normalizedBaseUrl: string | undefined;
  if (type === 'gemini' || profile?.adapter === 'gemini') {
    endpointHost = 'generativelanguage.googleapis.com';
    normalizedBaseUrl = undefined;
  } else {
    const baseUrl =
      typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0
        ? options.baseUrl
        : (profile?.defaultBaseUrl ?? '');
    if (baseUrl.length === 0) {
      return {
        profileId: type,
        displayName,
        endpointHost,
        reachable: false,
        authenticated: false,
        modelAvailable: false,
        discoveryAvailable: false,
        code: 'configuration_error',
        message: 'The provider endpoint is not configured.',
      };
    }
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl, { allowInsecureLocalhost });
      endpointHost = new URL(normalizedBaseUrl).host;
    } catch (error) {
      const message = isProviderError(error)
        ? error.message
        : 'The provider endpoint configuration is invalid.';
      return {
        profileId: type,
        displayName,
        endpointHost,
        reachable: false,
        authenticated: false,
        modelAvailable: false,
        discoveryAvailable: false,
        code: 'configuration_error',
        message,
      };
    }
  }

  const loopback =
    normalizedBaseUrl === undefined
      ? false
      : new URL(normalizedBaseUrl).hostname === 'localhost' ||
        new URL(normalizedBaseUrl).hostname === '127.0.0.1' ||
        new URL(normalizedBaseUrl).hostname === '[::1]';
  const credentialRequired = credentialRequiredForProfile(type, loopback);

  if (credentialRequired && (options.apiKey === undefined || options.apiKey.trim().length === 0)) {
    return {
      profileId: type,
      displayName,
      endpointHost,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      discoveryAvailable: false,
      code: 'authentication_failed',
      message: `No API key is configured for ${displayName}. Set an API key for this profile.`,
    };
  }

  const model = options.model.trim();
  if (model.length === 0) {
    return {
      profileId: type,
      displayName,
      endpointHost,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      discoveryAvailable: false,
      code: 'configuration_error',
      message: 'A model name is required for the connection test.',
    };
  }

  // Discovery is attempted but does not gate the connection verdict.
  let discoveredModels: readonly string[] | undefined;
  let discoveryAvailable: boolean;
  try {
    const discovery = await listProviderModels({
      type,
      baseUrl: normalizedBaseUrl,
      apiKey: options.apiKey,
      timeoutMs,
      fetchImpl,
      allowInsecureLocalhost,
      token: options.token,
    });
    discoveryAvailable = discovery.status === 'available';
    if (discoveryAvailable) {
      discoveredModels = discovery.models;
    }
  } catch {
    discoveryAvailable = false;
  }

  // Minimal completion — no workspace content is sent.
  try {
    await withAbort(
      async (signal) => {
        void signal;
        const provider = createProvider(
          type,
          {
            apiKey: options.apiKey,
            baseUrl: normalizedBaseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/models',
            model,
            timeoutMs,
            temperature: 0,
            maxOutputTokens: 5,
            stream: false,
            allowInsecureLocalhost,
          },
          { fetchImpl },
        );
        await provider.complete(
          {
            model,
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false,
            temperature: 0,
            maxOutputTokens: 5,
          },
          { token: options.token, timeoutMs },
        );
      },
      { token: options.token, timeoutMs },
    );
    return {
      profileId: type,
      displayName,
      endpointHost,
      reachable: true,
      authenticated: credentialRequired ? true : true,
      modelAvailable: true,
      discoveryAvailable,
      code: 'success',
      message: discoveryAvailable
        ? 'Connection test succeeded and model discovery listed models.'
        : 'Connection test succeeded. Model discovery was unavailable; a manually entered model was used.',
      discoveredModels,
    };
  } catch (error) {
    if (isProviderError(error)) {
      const status = error.status;
      if (error.code === 'authentication') {
        return {
          profileId: type,
          displayName,
          endpointHost,
          reachable: true,
          authenticated: false,
          modelAvailable: false,
          discoveryAvailable,
          code: 'authentication_failed',
          message: error.message,
          httpStatus: status,
          discoveredModels,
        };
      }
      if (error.code === 'network' || error.code === 'timeout' || error.code === 'cancelled') {
        return {
          profileId: type,
          displayName,
          endpointHost,
          reachable: false,
          authenticated: false,
          modelAvailable: false,
          discoveryAvailable,
          code: 'network_error',
          message: error.message,
          discoveredModels,
        };
      }
      if (error.code === 'http' || error.message.includes('not found')) {
        return {
          profileId: type,
          displayName,
          endpointHost,
          reachable: true,
          authenticated: !credentialRequired,
          modelAvailable: false,
          discoveryAvailable,
          code: 'model_not_found',
          message: error.message,
          httpStatus: status,
          discoveredModels,
        };
      }
      if (error.code === 'server') {
        return {
          profileId: type,
          displayName,
          endpointHost,
          reachable: true,
          authenticated: !credentialRequired,
          modelAvailable: false,
          discoveryAvailable,
          code: 'server_error',
          message: error.message,
          httpStatus: status,
          discoveredModels,
        };
      }
      if (error.code === 'configuration') {
        return {
          profileId: type,
          displayName,
          endpointHost,
          reachable: false,
          authenticated: false,
          modelAvailable: false,
          discoveryAvailable,
          code: 'configuration_error',
          message: error.message,
          discoveredModels,
        };
      }
      return {
        profileId: type,
        displayName,
        endpointHost,
        reachable: true,
        authenticated: false,
        modelAvailable: false,
        discoveryAvailable,
        code: 'endpoint_error',
        message: error.message,
        httpStatus: status,
        discoveredModels,
      };
    }
    const safe = normalizeThrownError(error, options.apiKey);
    return {
      profileId: type,
      displayName,
      endpointHost,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      discoveryAvailable,
      code: 'unknown_error',
      message: safe.message,
      discoveredModels,
    };
  }
}
