import { expect } from 'chai';
import * as vscode from 'vscode';
import type { QuantsMindApi } from '../../src/api';
import { COMMANDS } from '../../src/commands/ids';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';

function extension(): vscode.Extension<QuantsMindApi> {
  const found = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
  expect(found, `Extension ${EXTENSION_ID} should be discoverable`).to.not.equal(undefined);
  return found as vscode.Extension<QuantsMindApi>;
}

suite('extension activation and manifest', () => {
  test('activates and exposes only the narrow public API', async () => {
    const ext = extension();
    const api = await ext.activate();

    expect(ext.isActive).to.equal(true);
    expect(api.version).to.equal('0.3.0');
    expect(api.getProviderStatus).to.be.a('function');
    expect(api.revealChat).to.be.a('function');
    expect(Object.keys(api).sort()).to.deep.equal(['getProviderStatus', 'revealChat', 'version']);
  });

  test('registers every contributed command', async () => {
    await extension().activate();
    const registered = await vscode.commands.getCommands(true);

    for (const command of Object.values(COMMANDS)) {
      expect(registered, command).to.include(command);
    }
  });

  test('declares the sidebar view, startup activation and safety capabilities', async () => {
    const manifest = extension().packageJSON as Record<string, unknown>;
    const contributes = manifest.contributes as Record<string, unknown>;

    expect(manifest.activationEvents).to.deep.equal(['onStartupFinished']);
    expect(manifest.main).to.equal('./out/src/extension.js');
    expect(manifest.preview).to.equal(true);

    const capabilities = manifest.capabilities as Record<string, unknown>;
    const untrusted = capabilities.untrustedWorkspaces as Record<string, unknown>;
    expect(untrusted.supported).to.equal(true);
    expect(capabilities.virtualWorkspaces).to.equal(true);

    const containers = contributes.viewsContainers as {
      activitybar: { id: string }[];
    };
    expect(containers.activitybar[0].id).to.equal('quantsmind');

    const views = contributes.views as {
      quantsmind: { id: string; type: string }[];
    };
    expect(views.quantsmind).to.have.length(1);
    expect(views.quantsmind[0].id).to.equal('quantsmind.chatView');
    expect(views.quantsmind[0].type).to.equal('webview');
  });

  test('scopes provider settings to the application and context limits to the resource', async () => {
    const manifest = extension().packageJSON as {
      contributes: {
        configuration: {
          properties: Record<string, { scope?: string; default?: unknown }>;
        };
      };
    };
    const properties = manifest.contributes.configuration.properties;

    expect(properties['quantsmind.provider.baseUrl'].scope).to.equal('application');
    expect(properties['quantsmind.provider.model'].scope).to.equal('application');
    expect(properties['quantsmind.provider.requestTimeoutMs'].scope).to.equal('application');
    expect(properties['quantsmind.context.excludeGlobs'].scope).to.equal('resource');
    expect(properties['quantsmind.context.maxFiles'].scope).to.equal('resource');

    const credentialSetting = Object.keys(properties).some((name) =>
      /api.?key|password|client.?secret/i.test(name),
    );
    expect(credentialSetting).to.equal(false);
  });

  test('reports provider status consistent with the current credential state', async () => {
    const api = await extension().activate();
    const status = await api.getProviderStatus();

    expect(status.providerType).to.equal('openai-compatible');
    expect(status.displayName).to.equal('OpenAI-compatible');
    expect(status.endpointHost).to.be.a('string');
    expect(status.ready).to.equal(status.hasCredential || !status.credentialRequired);
    expect(status.configurationError).to.equal(undefined);
  });

  test('open, new chat and log commands execute without throwing', async () => {
    await extension().activate();
    await vscode.commands.executeCommand(COMMANDS.openChat);
    await vscode.commands.executeCommand(COMMANDS.newChat);
    await vscode.commands.executeCommand(COMMANDS.showLog);
  });
});
