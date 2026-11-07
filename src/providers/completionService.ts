import type { SettingsService } from '../config/settings';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import { isLoopbackOrPrivateHost, normalizeBaseUrl } from './endpoint';
import { ProviderError, isProviderError, normalizeThrownError } from './errors';
import { listProviderModels, type ModelDiscoveryResult } from './modelDiscovery';
import { testProviderConnection, type ConnectionTestResult } from './connectionTest';
import {
  credentialRequiredForProfile,
  getProviderCapabilities,
  getProviderProfile,
  listProviderProfiles,
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
    const apiKey = await this.secrets.forProvider(config.type).get();
    const credentialRequired = credentialRequiredForProfile(config.type, loopback);

    if (apiKey === undefined && credentialRequired) {
      throw new ProviderError(
        'authentication',
        'No API key is configured for this provider.',
      );
    }

    // Respect capabilities: fall back to non-streaming when the selected
    // provider does not advertise streaming support.
    const capabilities = getProviderCapabilities(config.type);
    const effectiveStream = capabilities?.streaming === false ? false : config.stream;

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

    try {
      const result = await provider.complete(
        {
          model: config.model,
          messages,
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          stream: effectiveStream,
        },
        options,
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
    }
  }
}
