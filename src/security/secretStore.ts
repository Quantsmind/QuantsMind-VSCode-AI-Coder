import { validateCredential } from './credential';

export const LEGACY_API_KEY_SECRET_KEY = 'quantsmind.provider.openaiCompatible.apiKey';
export const API_KEY_SECRET_KEY = LEGACY_API_KEY_SECRET_KEY;

export function secretKeyForProvider(providerType: string): string {
  const normalized = providerType.trim();
  if (normalized.length === 0) {
    return LEGACY_API_KEY_SECRET_KEY;
  }
  return `quantsmind.provider.${normalized}.apiKey`;
}

export function isProviderApiKeySecretKey(key: string): boolean {
  return key.startsWith('quantsmind.provider.') && key.endsWith('.apiKey');
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/**
 * Minimal wrapper around VS Code SecretStorage. Keeping the dependency as a
 * structural interface makes the credential workflow unit-testable without
 * booting an extension host.
 *
 * Provider isolation (B1): each profile type has its own key via
 * `secretKeyForProvider`.
 * - The legacy camelCase key `quantsmind.provider.openaiCompatible.apiKey`
 *   is a fallback ONLY for `openai-compatible` (the original generic profile).
 * - `openai` uses only `quantsmind.provider.openai.apiKey` and never the legacy key.
 * - groq, openrouter, ollama, lm-studio, llama-cpp, vllm and gemini never
 *   inherit the legacy key.
 * Writes for openai-compatible migrate the legacy entry to its canonical key.
 */
export class SecretStore {
  public readonly key: string;
  private readonly legacyKeys: readonly string[];

  constructor(
    private readonly storage: SecretStorageLike,
    key: string = LEGACY_API_KEY_SECRET_KEY,
    legacyKeys: readonly string[] = [],
  ) {
    this.key = key;
    this.legacyKeys = [...legacyKeys];
  }

  static forProvider(storage: SecretStorageLike, providerType: string): SecretStore {
    const canonicalKey = secretKeyForProvider(providerType);
    const normalizedType = providerType.trim();
    // B1 isolation: the legacy camelCase key is only a fallback for the
    // original openai-compatible profile. The openai profile and every other
    // profile (groq, openrouter, ollama, lm-studio, llama-cpp, vllm, gemini)
    // must not inherit it.
    const legacyKeys: string[] =
      normalizedType === 'openai-compatible' ? [LEGACY_API_KEY_SECRET_KEY] : [];
    const deduplicated = legacyKeys.filter((legacyKey) => legacyKey !== canonicalKey);
    return new SecretStore(storage, canonicalKey, deduplicated);
  }

  forProvider(providerType: string): SecretStore {
    return SecretStore.forProvider(this.storage, providerType);
  }

  async get(): Promise<string | undefined> {
    const value = await this.storage.get(this.key);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    for (const legacyKey of this.legacyKeys) {
      const legacyValue = await this.storage.get(legacyKey);
      if (typeof legacyValue === 'string' && legacyValue.length > 0) {
        return legacyValue;
      }
    }
    return undefined;
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== undefined;
  }

  async set(raw: string): Promise<void> {
    const value = validateCredential(raw);
    await this.storage.store(this.key, value);
    for (const legacyKey of this.legacyKeys) {
      if (legacyKey !== this.key) {
        try {
          await this.storage.delete(legacyKey);
        } catch {
          // Best-effort legacy cleanup; the canonical credential is already stored.
        }
      }
    }
  }

  async clear(): Promise<void> {
    await this.storage.delete(this.key);
    for (const legacyKey of this.legacyKeys) {
      if (legacyKey !== this.key) {
        await this.storage.delete(legacyKey);
      }
    }
  }
}
