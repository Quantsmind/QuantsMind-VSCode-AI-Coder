import { expect } from 'chai';
import { DEFAULT_EXCLUDE_GLOBS, DEFAULT_MODEL, LIMITS } from '../../src/config/defaults';
import { resolveContextSettings, resolveProviderSettings } from '../../src/config/resolve';

suite('provider setting resolution', () => {
  test('falls back to defaults for missing values', () => {
    const resolved = resolveProviderSettings({});
    expect(resolved.type).to.equal('openai-compatible');
    expect(resolved.baseUrl).to.equal('https://api.openai.com/v1');
    expect(resolved.model).to.equal(DEFAULT_MODEL);
    expect(resolved.timeoutMs).to.equal(120_000);
    expect(resolved.maxOutputTokens).to.equal(2048);
    expect(resolved.temperature).to.equal(0.2);
    expect(resolved.stream).to.equal(true);
    expect(resolved.allowInsecureLocalhost).to.equal(true);
  });

  test('falls back when values have the wrong type or are blank', () => {
    const resolved = resolveProviderSettings({
      type: 42,
      baseUrl: '   ',
      model: null,
      timeoutMs: 'fast',
      maxOutputTokens: Number.NaN,
      temperature: {},
      stream: 'yes',
      allowInsecureLocalhost: 1,
    });
    expect(resolved.type).to.equal('openai-compatible');
    expect(resolved.baseUrl).to.equal('https://api.openai.com/v1');
    expect(resolved.model).to.equal(DEFAULT_MODEL);
    expect(resolved.timeoutMs).to.equal(120_000);
    expect(resolved.maxOutputTokens).to.equal(2048);
    expect(resolved.temperature).to.equal(0.2);
    expect(resolved.stream).to.equal(true);
    expect(resolved.allowInsecureLocalhost).to.equal(true);
  });

  test('clamps numeric settings to configured limits', () => {
    const low = resolveProviderSettings({
      timeoutMs: 1,
      maxOutputTokens: 1,
      temperature: -5,
    });
    expect(low.timeoutMs).to.equal(LIMITS.timeoutMs.min);
    expect(low.maxOutputTokens).to.equal(LIMITS.maxOutputTokens.min);
    expect(low.temperature).to.equal(LIMITS.temperature.min);

    const high = resolveProviderSettings({
      timeoutMs: 10_000_000,
      maxOutputTokens: 10_000_000,
      temperature: 50,
    });
    expect(high.timeoutMs).to.equal(LIMITS.timeoutMs.max);
    expect(high.maxOutputTokens).to.equal(LIMITS.maxOutputTokens.max);
    expect(high.temperature).to.equal(LIMITS.temperature.max);
  });

  test('rounds integer settings and preserves decimals for temperature', () => {
    const resolved = resolveProviderSettings({
      timeoutMs: 120_000.6,
      maxOutputTokens: 100.4,
      temperature: 0.75,
    });
    expect(resolved.timeoutMs).to.equal(120_001);
    expect(resolved.maxOutputTokens).to.equal(100);
    expect(resolved.temperature).to.equal(0.75);
  });

  test('trims string values and truncates excessive length', () => {
    const resolved = resolveProviderSettings({
      baseUrl: '  https://example.com/v1  ',
      model: `  ${'m'.repeat(300)}  `,
    });
    expect(resolved.baseUrl).to.equal('https://example.com/v1');
    expect(resolved.model).to.have.length(200);
  });
});

suite('context setting resolution', () => {
  test('always includes mandatory exclusions', () => {
    const resolved = resolveContextSettings({});
    for (const pattern of DEFAULT_EXCLUDE_GLOBS) {
      expect(resolved.excludeGlobs, pattern).to.include(pattern);
    }
    expect(resolved.maxFileSizeBytes).to.equal(256 * 1024);
    expect(resolved.maxTotalChars).to.equal(48_000);
    expect(resolved.maxFiles).to.equal(20);
  });

  test('merges and de-duplicates user exclusions without removing defaults', () => {
    const resolved = resolveContextSettings({
      excludeGlobs: ['fixtures/**', '  fixtures/**  ', '', 'generated/*', 42, 'x'.repeat(400)],
    });
    expect(resolved.excludeGlobs).to.include('fixtures/**');
    expect(resolved.excludeGlobs).to.include('generated/*');
    expect(resolved.excludeGlobs).to.include('.env');
    expect(resolved.excludeGlobs.filter((pattern) => pattern === 'fixtures/**')).to.have.length(1);
    expect(resolved.excludeGlobs).to.not.include('x'.repeat(400));
  });

  test('caps the number of user patterns', () => {
    const many = Array.from({ length: LIMITS.maxExcludePatterns + 20 }, (_, index) => `pattern-${index}/**`);
    const resolved = resolveContextSettings({ excludeGlobs: many });
    expect(resolved.excludeGlobs).to.have.length(
      DEFAULT_EXCLUDE_GLOBS.length + LIMITS.maxExcludePatterns,
    );
  });

  test('clamps context size settings and converts kilobytes to bytes', () => {
    const low = resolveContextSettings({ maxFileSizeKb: 0, maxTotalChars: 1, maxFiles: 0 });
    expect(low.maxFileSizeBytes).to.equal(LIMITS.maxFileSizeKb.min * 1024);
    expect(low.maxTotalChars).to.equal(LIMITS.maxTotalChars.min);
    expect(low.maxFiles).to.equal(LIMITS.maxFiles.min);

    const high = resolveContextSettings({
      maxFileSizeKb: 999_999,
      maxTotalChars: 999_999_999,
      maxFiles: 999_999,
    });
    expect(high.maxFileSizeBytes).to.equal(LIMITS.maxFileSizeKb.max * 1024);
    expect(high.maxTotalChars).to.equal(LIMITS.maxTotalChars.max);
    expect(high.maxFiles).to.equal(LIMITS.maxFiles.max);
  });
});
