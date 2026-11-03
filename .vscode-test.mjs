import { defineConfig } from '@vscode/test-cli';

const installation = process.env.VSCODE_INSTALLATION;
const version = process.env.VSCODE_TEST_VERSION ?? '1.95.0';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  ...(installation ? { useInstallation: { fromPath: installation } } : { version }),
  workspaceFolder: './test/fixtures/workspace',
  launchArgs: ['--disable-workspace-trust'],
  mocha: {
    ui: 'tdd',
    timeout: 60000,
    color: true,
  },
});
