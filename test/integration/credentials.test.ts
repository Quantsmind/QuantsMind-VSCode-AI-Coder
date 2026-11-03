import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import type { QuantsMindApi } from '../../src/api';
import { COMMANDS } from '../../src/commands/ids';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';
const TEST_KEY = 'sk-integration-test-0000000000000000';

function extension(): vscode.Extension<QuantsMindApi> {
  return vscode.extensions.getExtension<QuantsMindApi>(
    EXTENSION_ID,
  ) as vscode.Extension<QuantsMindApi>;
}

async function status(): Promise<Awaited<ReturnType<QuantsMindApi['getProviderStatus']>>> {
  const api = await extension().activate();
  return api.getProviderStatus();
}

async function clearStoredKey(sandbox: sinon.SinonSandbox): Promise<void> {
  sandbox.stub(vscode.window, 'showWarningMessage').callsFake((async () => 'Remove') as never);
  sandbox.stub(vscode.window, 'showInformationMessage').callsFake((async () => undefined) as never);
  await vscode.commands.executeCommand(COMMANDS.clearApiKey);
  sandbox.restore();
}

suite('credential handling through commands', () => {
  let sandbox: sinon.SinonSandbox;

  setup(async () => {
    sandbox = sinon.createSandbox();
    await clearStoredKey(sandbox);
  });

  teardown(async () => {
    sandbox.restore();
    sandbox = sinon.createSandbox();
    await clearStoredKey(sandbox);
  });

  test('stores a key in SecretStorage without writing it to settings', async () => {
    let inputOptions: vscode.InputBoxOptions | undefined;
    sandbox
      .stub(vscode.window, 'showInputBox')
      .callsFake((async (options?: vscode.InputBoxOptions) => {
        inputOptions = options;
        return TEST_KEY;
      }) as never);
    sandbox.stub(vscode.window, 'showInformationMessage').callsFake((async () => undefined) as never);

    await vscode.commands.executeCommand(COMMANDS.setApiKey);

    const current = await status();
    expect(current.hasCredential).to.equal(true);
    expect(current.ready).to.equal(true);

    expect(inputOptions).to.not.equal(undefined);
    expect(inputOptions?.password).to.equal(true);
    expect(inputOptions?.ignoreFocusOut).to.equal(true);
    expect(inputOptions?.validateInput?.('has spaces')).to.be.a('string');
    expect(inputOptions?.validateInput?.(TEST_KEY)).to.equal(undefined);

    const configuration = vscode.workspace.getConfiguration('quantsmind');
    const serialized = JSON.stringify({
      baseUrl: configuration.get('provider.baseUrl'),
      model: configuration.get('provider.model'),
      excludes: configuration.get('context.excludeGlobs'),
    });
    expect(serialized).to.not.contain(TEST_KEY);
  });

  test('cancelling the input leaves the credential state unchanged', async () => {
    sandbox.stub(vscode.window, 'showInputBox').callsFake((async () => undefined) as never);

    await vscode.commands.executeCommand(COMMANDS.setApiKey);

    expect((await status()).hasCredential).to.equal(false);
  });

  test('requires explicit confirmation before removing a key', async () => {
    sandbox
      .stub(vscode.window, 'showInputBox')
      .callsFake((async () => TEST_KEY) as never);
    sandbox.stub(vscode.window, 'showInformationMessage').callsFake((async () => undefined) as never);
    await vscode.commands.executeCommand(COMMANDS.setApiKey);
    expect((await status()).hasCredential).to.equal(true);

    sandbox.restore();
    sandbox = sinon.createSandbox();
    sandbox.stub(vscode.window, 'showWarningMessage').callsFake((async () => undefined) as never);
    await vscode.commands.executeCommand(COMMANDS.clearApiKey);
    expect((await status()).hasCredential).to.equal(true);
  });
});
