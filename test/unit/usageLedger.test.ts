import { expect } from 'chai';
import { UsageLedger, estimateCost } from '../../src/providers/usage';

suite('usage ledger', () => {
  test('records and aggregates usage reported by providers', () => {
    const ledger = new UsageLedger();
    ledger.record('openai', 'gpt-4o-mini', { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, new Date('2026-11-10T00:00:00Z'));
    ledger.record('openai', 'gpt-4o-mini', { promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    ledger.record('ollama', 'llama3.1', { promptTokens: 10, completionTokens: 5 });

    const summary = ledger.summary();
    expect(summary.records).to.equal(3);
    expect(summary.totalPromptTokens).to.equal(310);
    expect(summary.totalCompletionTokens).to.equal(155);
    expect(summary.totalTokens).to.equal(465);
    expect(summary.byProvider.openai.records).to.equal(2);
    expect(summary.byProvider.openai.totalTokens).to.equal(450);
    expect(summary.byProvider.ollama.totalTokens).to.equal(15);
  });

  test('providers that report no usage produce no record', () => {
    const ledger = new UsageLedger();
    expect(ledger.record('openai', 'gpt-4o-mini', undefined)).to.equal(undefined);
    expect(ledger.record('openai', 'gpt-4o-mini', {})).to.equal(undefined);
    expect(ledger.summary().records).to.equal(0);
  });

  test('filters by provider and bounds the ledger size', () => {
    const ledger = new UsageLedger();
    for (let index = 0; index < 600; index += 1) {
      ledger.record('ollama', 'm', { promptTokens: 1, completionTokens: 1 });
    }
    ledger.record('openai', 'g', { promptTokens: 7, completionTokens: 3 });

    expect(ledger.summary().records).to.equal(500); // capped
    expect(ledger.summary('openai').records).to.equal(1);
    expect(ledger.recent(5)).to.have.length(5);
    expect(ledger.recent(5)[0]?.providerType).to.equal('openai');
  });

  test('sanitizes absurd token counts and non-finite values', () => {
    const ledger = new UsageLedger();
    ledger.record('openai', 'gpt', { promptTokens: 1e15, completionTokens: Number.NaN });
    const record = ledger.recent(1)[0];
    expect(record?.promptTokens).to.equal(undefined);
    expect(record?.completionTokens).to.equal(undefined);
    expect(record?.totalTokens).to.equal(undefined);
  });
});

suite('cost estimation', () => {
  test('returns undefined without an explicit rate card and never invents pricing', () => {
    expect(estimateCost({ promptTokens: 1000, completionTokens: 500 })).to.equal(undefined);
  });

  test('estimates cost from an explicit rate card only', () => {
    const result = estimateCost(
      { promptTokens: 1_000_000, completionTokens: 500_000 },
      { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.6, currency: 'USD' },
    );
    expect(result?.inputCost).to.equal(0.15);
    expect(result?.outputCost).to.equal(0.3);
    expect(result?.totalCost).to.equal(0.45);
    expect(result?.currency).to.equal('USD');
  });
});
