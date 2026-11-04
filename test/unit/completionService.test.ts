import { expect } from 'chai';
import { CompletionService } from '../../src/providers/completionService';
import { ProviderError } from '../../src/providers/errors';
import { Logger } from '../../src/security/logger';
import { SecretStore } from '../../src/security/secretStore';
import type { ChatMessage } from '../../src/providers/types';
import {
  MemoryLogSink,
  MemorySecretStorage,
  createSettings,
  sendJson,
  sendSse,
  startMockServer,
} from './helpers';

const TEST_SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz';

function build(): {
  service: CompletionService;
  storage: MemorySecretStorage;
  sink: MemoryLogSink;
} {
  const storage = new MemorySecretStorage();
  const sink = new MemoryLogSink();
  const secrets = new SecretStore(storage);
  const logger = new Logger(sink);
  return {
    service: new CompletionService(secrets, createSettings(), logger),
    storage,
    sink,
  };
}

const messages: readonly ChatMessage[] = [{ role: 'user', content: 'Hello' }];

suite('completion service status', () => {
  test('reports a remote provider as not ready until a credential exists', async () => {
    const { service } = build();
    const status = await service.getStatus();

    expect(status.providerType).to.equal('openai-compatible');
    expect(status.displayName).to.equal('OpenAI-compatible');
    expect(status.endpointHost).to.equal('api.openai.com');
    expect(status.hasCredential).to.equal(false);
    expect(status.credentialRequired).to.equal(true);
    expect(status.ready).to.equal(false);
    expect(status.configurationError).to.equal(undefined);
  });

  test('reports a remote provider as ready once a credential exists', async () => {
    const { service, storage } = build();
    storage.values.set('quantsmind.provider.openaiCompatible.apiKey', TEST_SECRET);

    const status = await service.getStatus();
    expect(status.hasCredential).to.equal(true);
    expect(status.ready).to.equal(true);
  });

  test('does not require credentials for loopback endpoints', async () => {
    const provider = { baseUrl: 'http://127.0.0.1:11434/v1' };
    const service = new CompletionService(
      new SecretStore(new MemorySecretStorage()),
      createSettings(provider),
      new Logger(new MemoryLogSink()),
    );

    const status = await service.getStatus();
    expect(status.credentialRequired).to.equal(false);
    expect(status.ready).to.equal(true);
    expect(status.endpointHost).to.equal('127.0.0.1:11434');
  });

  test('surfaces configuration errors and unsupported provider types', async () => {
    const invalidUrl = new CompletionService(
      new SecretStore(new MemorySecretStorage()),
      createSettings({ baseUrl: 'http://example.com/v1' }),
      new Logger(new MemoryLogSink()),
    );
    const invalidStatus = await invalidUrl.getStatus();
    expect(invalidStatus.ready).to.equal(false);
    expect(invalidStatus.configurationError).to.be.a('string');

    const unsupported = new CompletionService(
      new SecretStore(new MemorySecretStorage()),
      createSettings({ type: 'not-registered' }),
      new Logger(new MemoryLogSink()),
    );
    const unsupportedStatus = await unsupported.getStatus();
    expect(unsupportedStatus.configurationError).to.contain('Unsupported provider type');
    expect(unsupportedStatus.ready).to.equal(false);
  });
});

suite('completion service requests', () => {
  test('refuses remote requests without a credential before any HTTP call', async () => {
    const { service } = build();

    let failure: unknown;
    try {
      await service.complete(messages);
    } catch (error) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(ProviderError);
    expect((failure as ProviderError).code).to.equal('authentication');
  });

  test('sends an authenticated request and logs only metadata', async () => {
    const server = await startMockServer((_incoming, response) =>
      sendSse(response, [
        { choices: [{ delta: { content: 'Hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    try {
      const sink = new MemoryLogSink();
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openaiCompatible.apiKey', TEST_SECRET);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: true }),
        new Logger(sink),
      );

      const deltas: string[] = [];
      const result = await service.complete(messages, { onDelta: (delta) => deltas.push(delta) });

      expect(result.text).to.equal('Hi');
      expect(deltas).to.deep.equal(['Hi']);

      expect(server.requests).to.have.length(1);
      expect(server.requests[0].headers.authorization).to.equal(`Bearer ${TEST_SECRET}`);

      expect(sink.text).to.contain('completion start');
      expect(sink.text).to.contain('completion success');
      expect(sink.text).to.not.contain(TEST_SECRET);
      expect(sink.text).to.not.contain('Hello');
    } finally {
      await server.close();
    }
  });

  test('allows unauthenticated loopback requests', async () => {
    const server = await startMockServer((_incoming, response) =>
      sendJson(response, 200, { choices: [{ message: { content: 'local' } }] }),
    );

    try {
      const service = new CompletionService(
        new SecretStore(new MemorySecretStorage()),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(new MemoryLogSink()),
      );

      const result = await service.complete(messages);
      expect(result.text).to.equal('local');
      expect(server.requests[0].headers.authorization).to.equal(undefined);
    } finally {
      await server.close();
    }
  });

  test('warns whenever a request actually goes over plain HTTP', async () => {
    const server = await startMockServer((_incoming, response) =>
      sendJson(response, 200, { choices: [{ message: { content: 'local' } }] }),
    );

    try {
      const sink = new MemoryLogSink();
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openaiCompatible.apiKey', TEST_SECRET);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(sink),
      );

      await service.complete(messages);
      await service.complete(messages);

      const warnings = sink.lines.filter((line) => line.includes('[warn] insecure transport'));
      expect(warnings).to.have.length(2);
      expect(warnings[0]).to.contain('scheme=http');
      expect(warnings[0]).to.contain('allowInsecureLocalhost=true');
      expect(sink.text).to.not.contain(TEST_SECRET);
      expect(sink.text).to.not.match(/Bearer\s/);

      const httpsSink = new MemoryLogSink();
      const httpsService = new CompletionService(
        new SecretStore(new MemorySecretStorage()),
        createSettings({ stream: false }),
        new Logger(httpsSink),
      );
      await httpsService.complete(messages).catch(() => undefined);
      expect(httpsSink.text).to.not.contain('insecure transport');
    } finally {
      await server.close();
    }
  });

  test('normalizes provider failures and records a safe log entry', async () => {
    const server = await startMockServer((_incoming, response) =>
      sendJson(response, 500, { error: { message: `upstream failed ${TEST_SECRET}` } }),
    );

    try {
      const sink = new MemoryLogSink();
      const storage = new MemorySecretStorage();
      storage.values.set('quantsmind.provider.openaiCompatible.apiKey', TEST_SECRET);
      const service = new CompletionService(
        new SecretStore(storage),
        createSettings({ baseUrl: server.baseUrl, stream: false }),
        new Logger(sink),
      );

      let failure: unknown;
      try {
        await service.complete(messages);
      } catch (error) {
        failure = error;
      }

      expect(failure).to.be.instanceOf(ProviderError);
      expect((failure as ProviderError).code).to.equal('server');
      expect(sink.text).to.contain('completion failed code=server');
      expect(sink.text).to.not.contain(TEST_SECRET);
    } finally {
      await server.close();
    }
  });
});
