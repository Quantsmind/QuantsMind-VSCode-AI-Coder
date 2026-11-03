import { expect } from 'chai';
import { CredentialValidationError } from '../../src/security/credential';
import { API_KEY_SECRET_KEY, SecretStore } from '../../src/security/secretStore';
import { MemorySecretStorage } from './helpers';

suite('secret storage', () => {
  test('stores and retrieves a validated credential under the namespaced key', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    await store.set('  sk-test-value  ');

    expect(storage.values.get(API_KEY_SECRET_KEY)).to.equal('sk-test-value');
    expect(await store.get()).to.equal('sk-test-value');
    expect(await store.has()).to.equal(true);
  });

  test('treats missing and empty entries as absent', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    expect(await store.get()).to.equal(undefined);
    expect(await store.has()).to.equal(false);

    storage.values.set(API_KEY_SECRET_KEY, '');
    expect(await store.get()).to.equal(undefined);
  });

  test('rejects invalid credentials without writing to storage', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    let failure: unknown;
    try {
      await store.set('invalid key with spaces');
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(CredentialValidationError);
    expect(storage.values.size).to.equal(0);
  });

  test('clears the stored credential', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);

    await store.set('sk-test-value');
    await store.clear();

    expect(await store.has()).to.equal(false);
  });

  test('supports a custom secret key', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage, 'custom.key');

    await store.set('sk-test-value');

    expect(storage.values.get('custom.key')).to.equal('sk-test-value');
    expect(storage.values.has(API_KEY_SECRET_KEY)).to.equal(false);
  });
});
