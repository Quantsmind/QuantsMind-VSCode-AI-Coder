import type { SettingsService } from '../config/settings';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import { modelSupportsNativeToolCalling } from './capabilities';
import { describeEndpointHost, isLoopbackOrPrivateHost, normalizeBaseUrl } from './endpoint';
import { ProviderError, isProviderError, normalizeThrownError } from './errors';
import { listProviderModels, type ModelDiscoveryResult } from './modelDiscovery';
import { testProviderConnection, type ConnectionTestResult } from './connectionTest';
import { withProviderRetry } from './retry';
import {
  credentialRequiredForProfile,
  getProviderCapabilities,
  getProviderProfile,
  listProviderProfiles,
  providerAccessClass,
  type ProviderCapabilities,
  type ProviderProfile,
} from './profiles';
import { createProvider, listProviderTypes, providerDisplayName } from './registry';
import type { ChatMessage, CompletionOptions, CompletionResult } from './types';

export interface ProviderStatus {
  readonly providerType: string;
  readonly displayName: string;
  readonly model: string;
  readonly endpointHost: string;
  readonly hasCredential: boolean;
  readonly credentialRequired: boolean;
  readonly ready: boolean;
  readonly configurationError?: string;
  readonly capabilities?: ProviderCapabilities;
  readonly access?: string;
}

export interface ProviderServiceDependencies {
  readonly fetchImpl?: typeof fetch;
}

export class CompletionService {
  constructor(
    private readonly secrets: SecretStore,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  async getStatus(): Promise<ProviderStatus> {
    const config = this.settings.getProviderSettings();
    const profile = getProviderProfile(config.type);
    const hasCredential = await this.secrets.forProvider(config.type).has();
    let endpointHost = 'invalid endpoint';
    let loopback = false;
    let configurationError: string | undefined;

    if (!listProviderTypes().includes(config.type)) {
      configurationError = `Unsupported provider type "${config.type}".`;
    }

    if (config.type === 'gemini' || profile?.adapter === 'gemini') {
      endpointHost = 'generativelanguage.googleapis.com';
      loopback = false;
    } else {
      try {
        const normalized = normalizeBaseUrl(config.baseUrl, {
          allowInsecureLocalhost: config.allowInsecureLocalhost,
        });
        endpointHost = new URL(normalized).host;
        loopback = isLoopbackOrPrivateHost(new URL(normalized).hostname);
      } catch (error) {
        configurationError = isProviderError(error)
          ? error.message
          : 'The provider endpoint configuration is invalid.';
      }
    }

    const credentialRequired = credentialRequiredForProfile(config.type, loopback);
    const ready =
      configurationError === undefined && (hasCredential || !credentialRequired);

    return {
      providerType: config.type,
      displayName: providerDisplayName(config.type) ?? config.type,
      model: config.model,
      endpointHost,
      hasCredential,
      credentialRequired,
      ready,
      configurationError,
      capabilities: getProviderCapabilities(config.type),
      access: providerAccessClass(config.type),
    };
  }

  getProfiles(): readonly ProviderProfile[] {
    return listProviderProfiles();
  }

  getCapabilities(): ProviderCapabilities | undefined {
    const config = this.settings.getProviderSettings();
    return getProviderCapabilities(config.type);
  }

  async listModels(options?: { fetchImpl?: typeof fetch }): Promise<ModelDiscoveryResult> {
    const config = this.settings.getProviderSettings();
    const apiKey = await this.secrets.forProvider(config.type).get();
    return listProviderModels({
      type: config.type,
      baseUrl: config.baseUrl,
      apiKey,
      timeoutMs: config.timeoutMs,
      allowInsecureLocalhost: config.allowInsecureLocalhost,
      fetchImpl: options?.fetchImpl,
    });
  }

  async testConnection(options?: { fetchImpl?: typeof fetch }): Promise<ConnectionTestResult> {
    const config = this.settings.getProviderSettings();
    const apiKey = await this.secrets.forProvider(config.type).get();
    const result = await testProviderConnection({
      type: config.type,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey,
      timeoutMs: config.timeoutMs,
      allowInsecureLocalhost: config.allowInsecureLocalhost,
      fetchImpl: options?.fetchImpl,
    });
    this.logger.info(
      `connection test profile=${result.profileId} reachable=${result.reachable} authenticated=${result.authenticated} modelAvailable=${result.modelAvailable} discoveryAvailable=${result.discoveryAvailable} code=${result.code}`,
    );
    return result;
  }

  async complete(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const config = this.settings.getProviderSettings();

    const profile = getProviderProfile(config.type);
    const isGemini = config.type === 'gemini' || profile?.adapter === 'gemini';
    const normalized = isGemini
      ? 'https://generativelanguage.googleapis.com/v1beta/models'
      : normalizeBaseUrl(config.baseUrl, {
          allowInsecureLocalhost: config.allowInsecureLocalhost,
        });
    const loopback = isGemini ? false : isLoopbackOrPrivateHost(new URL(normalized).hostname);
    if (!isGemini && normalized.startsWith('http:')) {
      this.logger.warn(
        `insecure transport provider=${config.type} host=${describeEndpointHost(normalized)} scheme=http allowInsecureLocalhost=${config.allowInsecureLocalhost} — this request and any stored secret reach the loopback host unencrypted`,
      );
    }
    const apiKey = await this.secrets.forProvider(config.type).get();
    const credentialRequired = credentialRequiredForProfile(config.type, loopback);

    if (apiKey === undefined && credentialRequired) {
      throw new ProviderError(
        'authentication',
        'No API key is configured for this provider.',
      );
    }

    // Respect capabilities: fall back to non-streaming when the selected
    // provider does not advertise streaming support. Tool calls also require
    // a non-streaming request in this implementation.
    const capabilities = getProviderCapabilities(config.type);
    const requestedTools = options.tools;
    const nativeToolCalling = modelSupportsNativeToolCalling(config.type, config.model);
    const tools = nativeToolCalling ? requestedTools : undefined;
    if (!nativeToolCalling && requestedTools !== undefined && requestedTools.length > 0) {
      // The caller keeps working through the JSON tool-call protocol; native
      // definitions are withheld rather than sent to a model that rejects them.
      this.logger.info(
        `native tools withheld provider=${config.type} model=${config.model} count=${requestedTools.length} reason=adapter-or-model-unsupported`,
      );
    }
    const requestedStream = options.stream ?? config.stream;
    const effectiveStream =
      capabilities?.streaming === false || (Array.isArray(tools) && tools.length > 0)
        ? false
        : requestedStream;

    const provider = createProvider(config.type, {
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      stream: effectiveStream,
      allowInsecureLocalhost: config.allowInsecureLocalhost,
    });

    const started = Date.now();
    const requestChars = messages.reduce((total, message) => total + message.content.length, 0);
    this.logger.info(
      `completion start provider=${config.type} model=${config.model} messages=${messages.length} chars=${requestChars} stream=${config.stream} timeoutMs=${config.timeoutMs}`,
    );

    const controller = new AbortController();
    const cancellation = options.token;
    const abortFromToken = (): void => {
      if (cancellation?.isCancellationRequested) {
        controller.abort();
      }
    };
    abortFromToken();
    const disposable = cancellation?.onCancellationRequested(() => {
      controller.abort();
    });

    let streamStarted = false;
    const wrappedOnDelta = options.onDelta === undefined
      ? undefined
      : (delta: string) => {
          streamStarted = true;
          options.onDelta?.(delta);
        };

    try {
      const result = await withProviderRetry(
        async (signal) => {
          void signal;
          return await provider.complete(
            {
              model: config.model,
              messages,
              temperature: config.temperature,
              maxOutputTokens: config.maxOutputTokens,
              stream: effectiveStream,
              tools,
            },
            {
              ...options,
              token: options.token,
              onDelta: wrappedOnDelta,
            },
          );
        },
        {
          token: options.token,
          streamStarted: () => streamStarted,
        },
        controller.signal,
      );
      this.logger.info(
        `completion success durationMs=${Date.now() - started} chars=${result.text.length} finishReason=${result.finishReason ?? 'unknown'}`,
      );
      return result;
    } catch (error) {
      const normalizedError = isProviderError(error)
        ? error
        : normalizeThrownError(error);
      this.logger.error(
        `completion failed code=${normalizedError.code} status=${normalizedError.status ?? 'none'} retryable=${normalizedError.retryable} durationMs=${Date.now() - started}`,
        normalizedError,
      );
      throw normalizedError;
    } finally {
      disposable?.dispose();
    }
  }
}
