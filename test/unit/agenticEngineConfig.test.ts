import { expect } from 'chai';
import { resolveAgenticEngineSettings } from '../../src/config/resolve';

suite('agentic engine settings validation', () => {
  test('defaults are conservative and present when nothing is set', () => {
    const resolved = resolveAgenticEngineSettings({});

    expect(resolved.maxIterations).to.equal(10);
    expect(resolved.maxToolCalls).to.equal(40);
    expect(resolved.maxPlanRevisions).to.equal(2);
    expect(resolved.maxDurationMs).to.equal(600_000);
    expect(resolved.maxChangedFiles).to.equal(25);
  });

  test('honors explicit values within bounds', () => {
    const resolved = resolveAgenticEngineSettings({
      maxIterations: 20,
      maxToolCalls: 100,
      maxPlanRevisions: 4,
      maxDurationSeconds: 300,
      maxChangedFiles: 10,
    });

    expect(resolved.maxIterations).to.equal(20);
    expect(resolved.maxToolCalls).to.equal(100);
    expect(resolved.maxPlanRevisions).to.equal(4);
    expect(resolved.maxDurationMs).to.equal(300_000);
    expect(resolved.maxChangedFiles).to.equal(10);
  });

  test('seconds map to milliseconds and clamp at the bounds', () => {
    const high = resolveAgenticEngineSettings({ maxDurationSeconds: 9_999 });
    expect(high.maxDurationMs).to.equal(1_800_000);

    const low = resolveAgenticEngineSettings({ maxDurationSeconds: 1 });
    expect(low.maxDurationMs).to.equal(60_000);
  });

  test('non-finite and invalid values fall back to defaults or clamps, never to unlimited', () => {
    const resolved = resolveAgenticEngineSettings({
      maxIterations: Number.NaN,
      maxToolCalls: -5,
      maxPlanRevisions: 'many' as unknown as number,
      maxDurationSeconds: Number.POSITIVE_INFINITY,
      maxChangedFiles: 0,
    });

    expect(resolved.maxIterations).to.equal(10);
    expect(resolved.maxToolCalls).to.equal(1); // clamped at min, not unlimited
    expect(resolved.maxPlanRevisions).to.equal(2);
    expect(resolved.maxDurationMs).to.equal(600_000);
    expect(resolved.maxChangedFiles).to.equal(1); // clamped at min
  });

  test('huge wrong-type values cannot disable protections', () => {
    const resolved = resolveAgenticEngineSettings({
      maxIterations: '999999' as unknown as number,
      maxDurationSeconds: 'forever' as unknown as number,
    });

    expect(resolved.maxIterations).to.equal(10); // strings are not accepted; default applies
    expect(resolved.maxDurationMs).to.equal(600_000);
  });
});
