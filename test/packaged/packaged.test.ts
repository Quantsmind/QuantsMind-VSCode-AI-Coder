import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect } from 'chai';
import * as vscode from 'vscode';
import type { QuantsMindApi } from '../../src/api';
import { COMMANDS } from '../../src/commands/ids';

const EXTENSION_ID = 'quantsmind.quantsmind-vscode-ai-coder';

suite('packaged extension', () => {
  test('is installed as a VSIX rather than loaded from the workspace', async () => {
    const extension = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
    expect(extension, `${EXTENSION_ID} should be installed`).to.not.equal(undefined);

    const projectRoot = resolve(__dirname, '../../..');
    expect(resolve(extension!.extensionPath)).to.not.equal(projectRoot);
    expect(extension!.extensionPath).to.not.contain('packaged-extension');
    expect(extension!.extensionPath).to.contain('quantsmind-vscode-ai-coder');
  });

  test('contains the expected packaged files', async () => {
    const extension = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
    expect(extension).to.not.equal(undefined);
    const root = extension!.extensionPath;

    for (const file of [
      'package.json',
      'readme.md',
      'LICENSE.txt',
      'changelog.md',
      'out/src/extension.js',
      'media/chat.js',
      'media/chat.css',
      'media/icon.svg',
      'node_modules/minimatch/package.json',
    ]) {
      expect(existsSync(join(root, ...file.split('/'))), file).to.equal(true);
    }
  });

  test('activates, exposes the narrow API and registers commands', async () => {
    const extension = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
    expect(extension).to.not.equal(undefined);

    const api = await extension!.activate();
    expect(extension!.isActive).to.equal(true);
    expect(api.version).to.equal(extension!.packageJSON.version);
    expect(Object.keys(api).sort()).to.deep.equal(['getProviderStatus', 'revealChat', 'version']);

    const registered = await vscode.commands.getCommands(true);
    for (const command of Object.values(COMMANDS)) {
      expect(registered, command).to.include(command);
    }

    const status = await api.getProviderStatus();
    expect(status.providerType).to.equal('openai-compatible');
    expect(status.ready).to.equal(status.hasCredential || !status.credentialRequired);
  });

  test('can open the packaged chat view without a development host', async () => {
    const extension = vscode.extensions.getExtension<QuantsMindApi>(EXTENSION_ID);
    const api = await extension!.activate();

    await api.revealChat();
    await vscode.commands.executeCommand(COMMANDS.newChat);
    await vscode.commands.executeCommand(COMMANDS.showLog);
  });
});
