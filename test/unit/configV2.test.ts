import { expect } from 'chai';
import {
  DEFAULT_COMMAND_ALLOWLIST,
  DEFAULT_WORKSPACE_MAX_INDEXED_FILES,
  DEFAULT_WORKSPACE_MAX_RETRIEVED_FILES,
  DEFAULT_WORKSPACE_RETRIEVAL_MAX_CHARS,
} from '../../src/config/defaults';
import {
  resolveAgentSettings,
  resolveCommandSettings,
  resolveWorkspaceSettings,
} from '../../src/config/resolve';

suite('v0.2.0 setting resolution', () => {
  test('uses workspace defaults for missing or invalid values', () => {
    const resolved = resolveWorkspaceSettings({
      maxIndexedFiles: 'many',
      maxRetrievedFiles: null,
      retrievalMaxChars: Number.NaN,
    });
    expect(resolved.maxIndexedFiles).to.equal(DEFAULT_WORKSPACE_MAX_INDEXED_FILES);
    expect(resolved.maxRetrievedFiles).to.equal(DEFAULT_WORKSPACE_MAX_RETRIEVED_FILES);
    expect(resolved.retrievalMaxChars).to.equal(DEFAULT_WORKSPACE_RETRIEVAL_MAX_CHARS);
  });

  test('clamps workspace limits', () => {
    expect(
      resolveWorkspaceSettings({ maxIndexedFiles: 1, maxRetrievedFiles: 0, retrievalMaxChars: 1 }),
    ).to.deep.equal({ maxIndexedFiles: 100, maxRetrievedFiles: 1, retrievalMaxChars: 2_000 });
    expect(
      resolveWorkspaceSettings({
        maxIndexedFiles: 1_000_000,
        maxRetrievedFiles: 500,
        retrievalMaxChars: 900_000,
      }),
    ).to.deep.equal({ maxIndexedFiles: 20_000, maxRetrievedFiles: 50, retrievalMaxChars: 200_000 });
  });

  test('shortens and expands the agent task to configured limits', () => {
    expect(resolveAgentSettings({ maxSteps: 'x', maxRepairIterations: -3, timeoutMs: 1 })).to.deep.equal(
      { maxSteps: 6, maxRepairIterations: 0, timeoutMs: 10_000 },
    );
    expect(
      resolveAgentSettings({ maxSteps: 99, maxRepairIterations: 99, timeoutMs: 9_999_999 }),
    ).to.deep.equal({ maxSteps: 20, maxRepairIterations: 5, timeoutMs: 900_000 });
  });

  test('defaults the command allowlist when the setting is not an array', () => {
    expect(resolveCommandSettings({ allowlist: 'npm test' }).allowlist).to.deep.equal(
      DEFAULT_COMMAND_ALLOWLIST,
    );
  });

  test('drops unsafe, blank, duplicate, and oversized allowlist entries', () => {
    const resolved = resolveCommandSettings({
      allowlist: [
        '  npm   run   compile ',
        'npm run compile',
        'npm test && rm -rf /',
        'npm test | tee out',
        'npm test > out',
        'npm test $(whoami)',
        'npm test `whoami`',
        'npm test &',
        '',
        42,
        'x'.repeat(300),
        'npm run lint',
      ],
    });
    expect(resolved.allowlist).to.deep.equal(['npm run compile', 'npm run lint']);
  });

  test('caps and clamps command execution settings', () => {
    const many = Array.from({ length: 30 }, (_, index) => `command ${index}`);
    const resolved = resolveCommandSettings({ allowlist: many, timeoutMs: 1, maxOutputChars: 1 });
    expect(resolved.allowlist).to.have.length(20);
    expect(resolved.timeoutMs).to.equal(1_000);
    expect(resolved.maxOutputChars).to.equal(1_000);

    const huge = resolveCommandSettings({ timeoutMs: 10_000_000, maxOutputChars: 10_000_000 });
    expect(huge.timeoutMs).to.equal(600_000);
    expect(huge.maxOutputChars).to.equal(1_000_000);
  });
});
