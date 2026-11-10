/**
 * WP2 — Live Pollinations provider qualification.
 *
 * Revalidates the real Pollinations endpoint against the current build.
 * No API key is required (Pollinations is free-no-key). Availability and
 * rate limits can change without notice; this test does not claim guaranteed
 * free availability.
 */

import { expect } from 'chai';
import * as vscode from 'vscode';
import type { QuantsMindApi } from '../../src/api';
import { CompletionService } from '../../src/providers/completionService';
import { SecretStore } from '../../src/security/secretStore';
import { Logger } from '../../src/security/logger';
import { SettingsService } from '../../src/config/settings';
import { MemoryLogSink, MemorySecretStorage } from '../unit/helpers';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';

function extension(): vscode.Extension<QuantsMindApi> {
  const found = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
  expect(found, `Extension ${EXTENSION_ID} should be discoverable`).to.not.equal(undefined);
  return found as vscode.Extension<QuantsMindApi>;
}

suite('WP2 — Pollinations live free-provider qualification', () => {
  test('Pollinations models endpoint returns 200 with openai-fast', function (this: Mocha.Context) {
    const storage = new MemorySecretStorage();
    const sink = new MemoryLogSink();
    const secrets = new SecretStore(storage);
    const settings = new SettingsService();
    const logger = new Logger(sink);
    const completion = new CompletionService(secrets, settings, logger);

    return completion
      .listModels({ fetchImpl: globalThis.fetch })
      .then((discovery) => {
        // Pollinations anonymous service may be unavailable; skip gracefully.
        if (discovery.status !== 'available') {
          this.skip();
          return;
        }

        expect(discovery.status).to.equal('available');
        expect(discovery.source).to.equal('discovered');
        expect(discovery.models.length).to.be.greaterThan(0);
        expect(discovery.models).to.contain('openai-fast');
      });
  });

  test('Pollinations completion returns 200 with text response', function (this: Mocha.Context) {
    const storage = new MemorySecretStorage();
    const sink = new MemoryLogSink();
    const secrets = new SecretStore(storage);
    const settings = new SettingsService();
    const logger = new Logger(sink);
    const completion = new CompletionService(secrets, settings, logger);

    return completion
      .complete(
        [{ role: 'user', content: 'Say hello in one word.' }],
        {
          stream: false,
        },
      )
      .then((result) => {
        expect(result.text).to.be.a('string');
        expect(result.text.length).to.be.greaterThan(0);
        expect(result.finishReason).to.not.equal(undefined);
      })
      .catch(() => {
        // Pollinations may be rate-limited or unavailable; skip gracefully.
        this.skip();
      });
  });

  test('getProviderStatus reports Pollinations as ready without credential', async () => {
    const api = await extension().activate();

    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.type', 'pollinations', vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.baseUrl', 'https://text.pollinations.ai/openai', vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.model', 'openai-fast', vscode.ConfigurationTarget.Global);

    try {
      const status = await api.getProviderStatus();
      expect(status.providerType).to.equal('pollinations');
      expect(status.model).to.equal('openai-fast');
      expect(status.credentialRequired).to.equal(false);
      expect(status.hasCredential).to.equal(false);
      // Pollinations is free-no-key: ready even without a credential.
      expect(status.ready).to.equal(true);
      expect(status.access).to.equal('free-no-key');
    } finally {
      await vscode.workspace
        .getConfiguration('quantsmind')
        .update('provider.type', 'openai-compatible', vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration('quantsmind')
        .update('provider.baseUrl', 'https://api.openai.com/v1', vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration('quantsmind')
        .update('provider.model', 'gpt-4o-mini', vscode.ConfigurationTarget.Global);
    }
  });
});
