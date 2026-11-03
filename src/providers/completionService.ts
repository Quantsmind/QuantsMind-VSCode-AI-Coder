import type { SettingsService } from '../config/settings';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import { isLoopbackHost, normalizeBaseUrl } from './endpoint';
import { ProviderError, isProviderError, normalizeThrownError } from './errors';
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
}

export class CompletionService {
  constructor(
    private readonly secrets: SecretStore,
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  async getStatus(): Promise<ProviderStatus> {
    const config = this.settings.getProviderSettings();
    const hasCredential = await this.secrets.has();
    let endpointHost = 'invalid endpoint';
    let loopback = false;
    let configurationError: string | undefined;

    if (!listProviderTypes().includes(config.type)) {
      configurationError = `Unsupported provider type "${config.type}".`;
    }

    try {
      const normalized = normalizeBaseUrl(config.baseUrl, {
        allowInsecureLocalhost: config.allowInsecureLocalhost,
      });
      endpointHost = new URL(normalized).host;
      loopback = isLoopbackHost(new URL(normalized).hostname);
    } catch (error) {
      configurationError = isProviderError(error)
        ? error.message
        : 'The provider endpoint configuration is invalid.';
    }

    const credentialRequired = !loopback;
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
    };
  }

  async complete(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    const config = this.settings.getProviderSettings();

    const normalized = normalizeBaseUrl(config.baseUrl, {
      allowInsecureLocalhost: config.allowInsecureLocalhost,
    });
    const loopback = isLoopbackHost(new URL(normalized).hostname);
    const apiKey = await this.secrets.get();

    if (apiKey === undefined && !loopback) {
      throw new ProviderError(
        'authentication',
        'No API key is configured for this provider.',
      );
    }

    const provider = createProvider(config.type, {
      apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      stream: config.stream,
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
          stream: config.stream,
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
