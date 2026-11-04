import { defineConfig } from '@vscode/test-cli';

const installation = process.env.VSCODE_INSTALLATION;
const version = process.env.VSCODE_TEST_VERSION ?? '1.95.0';
const vsix = process.env.QUANTSMIND_VSIX ?? './quantsmind-vscode-ai-coder-0.3.3.vsix';

export default defineConfig({
  files: 'out/test/packaged/**/*.test.js',
  extensionDevelopmentPath: './test/packaged-extension',
  installExtensions: [vsix],
  workspaceFolder: './test/fixtures/workspace',
  ...(installation ? { useInstallation: { fromPath: installation } } : { version }),
  launchArgs: ['--disable-workspace-trust'],
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
});
