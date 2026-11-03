import { validateCredential } from './credential';

export const API_KEY_SECRET_KEY = 'quantsmind.provider.openaiCompatible.apiKey';

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/**
 * Minimal wrapper around VS Code SecretStorage. Keeping the dependency as a
 * structural interface makes the credential workflow unit-testable without
 * booting an extension host.
 */
export class SecretStore {
  constructor(
    private readonly storage: SecretStorageLike,
    private readonly key: string = API_KEY_SECRET_KEY,
  ) {}

  async get(): Promise<string | undefined> {
    const value = await this.storage.get(this.key);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== undefined;
  }

  async set(raw: string): Promise<void> {
    const value = validateCredential(raw);
    await this.storage.store(this.key, value);
  }

  async clear(): Promise<void> {
    await this.storage.delete(this.key);
  }
}
