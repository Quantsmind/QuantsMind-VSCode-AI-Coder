import { expect } from 'chai';
import { CompletionService } from '../../src/providers/completionService';
import { Logger } from '../../src/security/logger';
import { SecretStore } from '../../src/security/secretStore';
import { MemoryLogSink, MemorySecretStorage, createSettings } from './helpers';

const TEST_KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz';
const GEMINI_KEY = 'AQ-test-key-1234567890';

suite('provider switching and completion service profiles', () => {
  test('reports distinct status for local vs cloud profiles with shared storage', async () => {
    const storage = new MemorySecretStorage();
    const logger = new Logger(new MemoryLogSink());

    const ollamaService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'ollama', baseUrl: 'http://localhost:11434/v1' }),
      logger,
    );
    const ollamaStatus = await ollamaService.getStatus();
    expect(ollamaStatus.providerType).to.equal('ollama');
    expect(ollamaStatus.credentialRequired).to.equal(false);
    expect(ollamaStatus.ready).to.equal(true);

    const geminiService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'gemini', model: 'gemini-2.0-flash' }),
      logger,
    );
    const geminiStatus = await geminiService.getStatus();
    expect(geminiStatus.providerType).to.equal('gemini');
    expect(geminiStatus.credentialRequired).to.equal(true);
    expect(geminiStatus.ready).to.equal(false);
    expect(geminiStatus.endpointHost).to.equal('generativelanguage.googleapis.com');
  });

  test('isolates credentials when switching between cloud profiles', async () => {
    const storage = new MemorySecretStorage();
    const logger = new Logger(new MemoryLogSink());
    storage.values.set('quantsmind.provider.openai.apiKey', TEST_KEY);

    const openaiService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'openai' }),
      logger,
    );
    const openaiStatus = await openaiService.getStatus();
    expect(openaiStatus.hasCredential).to.equal(true);
    expect(openaiStatus.ready).to.equal(true);

    const groqService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'groq', baseUrl: 'https://api.groq.com/openai/v1' }),
      logger,
    );
    const groqStatus = await groqService.getStatus();
    expect(groqStatus.hasCredential).to.equal(false);
    expect(groqStatus.ready).to.equal(false);
  });

  test('exposes capabilities through completion service', async () => {
    const storage = new MemorySecretStorage();
    const logger = new Logger(new MemoryLogSink());
    const service = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'gemini', model: 'gemini-2.0-flash' }),
      logger,
    );
    const caps = service.getCapabilities();
    expect(caps?.completion).to.equal(true);
    expect(caps?.streaming).to.equal(true);
    expect(caps?.toolCalling).to.equal(false);

    const status = await service.getStatus();
    expect(status.capabilities?.modelDiscovery).to.equal(true);
  });

  test('local profiles do not require credentials for readiness', async () => {
    const storage = new MemorySecretStorage();
    const logger = new Logger(new MemoryLogSink());
    for (const type of ['ollama', 'lm-studio', 'llama-cpp', 'vllm']) {
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ type, baseUrl: 'http://localhost:9999/v1' }),
        logger,
      );
      const status = await service.getStatus();
      expect(status.credentialRequired).to.equal(false);
      expect(status.ready).to.equal(true);
    }
  });

  test('gemini profile requires its own credential and not the openai one', async () => {
    const storage = new MemorySecretStorage();
    storage.values.set('quantsmind.provider.openai.apiKey', TEST_KEY);
    const logger = new Logger(new MemoryLogSink());

    const geminiService = new CompletionService(
      new SecretStore(storage),
      createSettings({ type: 'gemini' }),
      logger,
    );
    expect((await geminiService.getStatus()).hasCredential).to.equal(false);

    storage.values.set('quantsmind.provider.gemini.apiKey', GEMINI_KEY);
    const withKey = await geminiService.getStatus();
    expect(withKey.hasCredential).to.equal(true);
    expect(withKey.ready).to.equal(true);
  });

  test('lists provider profiles through completion service', () => {
    const service = new CompletionService(
      new SecretStore(new MemorySecretStorage()),
      createSettings(),
      new Logger(new MemoryLogSink()),
    );
    const profiles = service.getProfiles();
    expect(profiles).to.have.length(9);
    expect(profiles.map((p) => p.id)).to.contain('ollama');
    expect(profiles.map((p) => p.id)).to.contain('gemini');
  });
});
