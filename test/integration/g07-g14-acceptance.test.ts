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

async function resetProviderConfig(): Promise<void> {
  const config = vscode.workspace.getConfiguration('quantsmind');
  await config.update('provider.type', 'openai-compatible', vscode.ConfigurationTarget.Global);
  await config.update('provider.baseUrl', 'https://api.openai.com/v1', vscode.ConfigurationTarget.Global);
  await config.update('provider.model', 'gpt-4o-mini', vscode.ConfigurationTarget.Global);
}

suite('G07-G14 Manual GUI Acceptance Cases', () => {
  test('G07: Test Provider Connection with Pollinations (free, no key)', async () => {
    const api = await extension().activate();

    // Select Pollinations provider (free, no key required)
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
      // Verify status shows Pollinations is ready (no key required)
      const status = await api.getProviderStatus();
      expect(status.providerType).to.equal('pollinations');
      expect(status.ready).to.equal(true);
      expect(status.credentialRequired).to.equal(false);

      // Execute connection test via CompletionService directly (command shows notification instead of returning)
      const storage = new MemorySecretStorage();
      const sink = new MemoryLogSink();
      const secrets = new SecretStore(storage);
      const settings = new SettingsService();
      const logger = new Logger(sink);
      const completion = new CompletionService(secrets, settings, logger);
      const connResult = await completion.testConnection();

      expect(connResult).to.not.equal(undefined);
      expect(connResult.code).to.equal('success');
      expect(connResult.reachable).to.equal(true);
      expect(connResult.authenticated).to.equal(true);
      expect(connResult.profileId).to.equal('pollinations');
    } finally {
      await resetProviderConfig();
    }
  });

  test('G13: Paid provider (OpenAI) without API key - connection test fails with auth error', async () => {
    const api = await extension().activate();

    // Select OpenAI (paid provider) without setting an API key
    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.type', 'openai', vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.baseUrl', 'https://api.openai.com/v1', vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('quantsmind')
      .update('provider.model', 'gpt-4o-mini', vscode.ConfigurationTarget.Global);

    try {
      // Verify status shows credential required but not present
      const status = await api.getProviderStatus();
      expect(status.providerType).to.equal('openai');
      expect(status.credentialRequired).to.equal(true);
      expect(status.hasCredential).to.equal(false);
      expect(status.ready).to.equal(false);

      // Execute connection test - should fail with authentication error
      const storage = new MemorySecretStorage();
      const sink = new MemoryLogSink();
      const secrets = new SecretStore(storage);
      const settings = new SettingsService();
      const logger = new Logger(sink);
      const completion = new CompletionService(secrets, settings, logger);
      const connResult = await completion.testConnection();

      expect(connResult).to.not.equal(undefined);
      expect(connResult.code).to.equal('authentication_failed');
      expect(connResult.reachable).to.equal(false);
      expect(connResult.authenticated).to.equal(false);
      expect(connResult.profileId).to.equal('openai');

      // Verify no silent switch - provider type is still OpenAI
      const statusAfter = await api.getProviderStatus();
      expect(statusAfter.providerType).to.equal('openai');
      expect(statusAfter.displayName).to.equal('OpenAI');
    } finally {
      await resetProviderConfig();
    }
  });

  test('G14: Provider/model persistence across reload (settings stored)', async () => {
    const api = await extension().activate();

    try {
      // Select Pollinations provider and model
      await vscode.workspace
        .getConfiguration('quantsmind')
        .update('provider.type', 'pollinations', vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration('quantsmind')
        .update('provider.model', 'openai-fast', vscode.ConfigurationTarget.Global);

      // Verify settings are stored at application scope (global)
      const config = vscode.workspace.getConfiguration('quantsmind');
      const providerType = config.get('provider.type');
      const providerModel = config.get('provider.model');

      expect(providerType).to.equal('pollinations');
      expect(providerModel).to.equal('openai-fast');

      // Verify status reflects the stored configuration
      const status = await api.getProviderStatus();
      expect(status.providerType).to.equal('pollinations');
      expect(status.model).to.equal('openai-fast');
      expect(status.ready).to.equal(true);

      // Application-scoped settings persist across VS Code reloads by design
      // Verifying they are stored at Global scope (not Workspace)
      const inspected = config.inspect('provider.type');
      expect(inspected).to.not.equal(undefined);
      expect(inspected!.globalValue).to.equal('pollinations');
    } finally {
      await resetProviderConfig();
    }
  });
});
