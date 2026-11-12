import type { CompletionUsage } from '../providers/types';

export interface UsageRecord {
  readonly providerType: string;
  readonly model: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly at: string;
}

export interface UsageSummary {
  readonly records: number;
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly totalTokens: number;
  readonly byProvider: Readonly<Record<string, { records: number; totalTokens: number }>>;
}

export interface RateCard {
  readonly inputPerMillionTokens: number;
  readonly outputPerMillionTokens: number;
  readonly currency: string;
}

const MAX_RECORDS = 500;
const MAX_FIELD = 1e12;
const MAX_PROVIDER = 64;
const MAX_MODEL = 128;

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_FIELD ? Math.floor(parsed) : undefined;
}

function shortString(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, max)
    .trim();
}

/**
 * Token usage ledger. It records what providers report; it never estimates
 * usage that was not reported. Cost estimation is only available when the
 * host supplies an explicit rate card — rates are never invented.
 */
export class UsageLedger {
  private records: UsageRecord[] = [];

  record(providerType: string, model: string, usage?: CompletionUsage, at?: Date): UsageRecord | undefined {
    const provider = shortString(providerType, MAX_PROVIDER);
    const modelName = shortString(model, MAX_MODEL);
    if (provider.length === 0 || modelName.length === 0) {
      return undefined;
    }
    const promptTokens = finiteNonNegative(usage?.promptTokens);
    const completionTokens = finiteNonNegative(usage?.completionTokens);
    const totalTokens = finiteNonNegative(usage?.totalTokens) ?? (((promptTokens ?? 0) + (completionTokens ?? 0)) || undefined);

    // Providers that report nothing produce no record.
    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return undefined;
    }

    const entry: UsageRecord = {
      providerType: provider,
      model: modelName,
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      at: (at ?? new Date()).toISOString(),
    };
    this.records.push(entry);
    while (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
    return entry;
  }

  summary(filter?: string): UsageSummary {
    const filtered = filter === undefined ? this.records : this.records.filter((record) => record.providerType === filter);
    let prompt = 0;
    let completion = 0;
    let total = 0;
    const byProvider: Record<string, { records: number; totalTokens: number }> = {};
    for (const record of filtered) {
      prompt += record.promptTokens ?? 0;
      completion += record.completionTokens ?? 0;
      total += record.totalTokens ?? 0;
      const bucket = byProvider[record.providerType] ?? { records: 0, totalTokens: 0 };
      bucket.records += 1;
      bucket.totalTokens += record.totalTokens ?? 0;
      byProvider[record.providerType] = bucket;
    }
    return {
      records: filtered.length,
      totalPromptTokens: prompt,
      totalCompletionTokens: completion,
      totalTokens: total,
      byProvider,
    };
  }

  recent(limit = 10): readonly UsageRecord[] {
    const bounded = Math.max(1, Math.min(limit, 50));
    return this.records.slice(-bounded).reverse();
  }

  clear(): void {
    this.records = [];
  }
}

/** Estimates cost from an explicit rate card; returns undefined when not provided. */
export function estimateCost(
  usage: { readonly promptTokens?: number; readonly completionTokens?: number },
  rateCard?: RateCard,
): { readonly inputCost: number; readonly outputCost: number; readonly totalCost: number; readonly currency: string } | undefined {
  if (rateCard === undefined) {
    return undefined;
  }
  const input = (finiteNonNegative(usage.promptTokens) ?? 0) * (rateCard.inputPerMillionTokens / 1_000_000);
  const output = (finiteNonNegative(usage.completionTokens) ?? 0) * (rateCard.outputPerMillionTokens / 1_000_000);
  const inputCost = round2(input);
  const outputCost = round2(output);
  return {
    inputCost,
    outputCost,
    totalCost: round2(inputCost + outputCost),
    currency: String(rateCard.currency ?? 'USD').slice(0, 8),
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
