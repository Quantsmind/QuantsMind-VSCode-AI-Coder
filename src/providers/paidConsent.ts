import { getProviderProfile } from './profiles';

export class PaidConsentError extends Error {
  constructor(readonly providerType: string, readonly access: string) {
    super(
      `Consent to use the paid provider "${providerType}" has not been granted for this session. ` +
        'Grant consent or switch to a free/local provider before continuing.',
    );
    this.name = 'PaidConsentError';
  }
}

const MAX_TRACKED = 100;

/**
 * Per-activation consent for paid provider calls made on the user's behalf.
 * Selection-time warnings exist elsewhere; this gate is the last line of
 * defense against silently burning paid quota from an agent run. Consent is
 * granted explicitly per provider type and never persisted.
 */
export class PaidProviderConsent {
  private readonly granted = new Set<string>();

  /** True when the provider is classified as paid (never inferred otherwise). */
  isPaid(providerType: string): boolean {
    return getProviderProfile(providerType)?.access === 'paid';
  }

  accessClass(providerType: string): string | undefined {
    return getProviderProfile(providerType)?.access;
  }

  /** True when a paid profile exists and consent has not been granted yet. */
  requiresConsent(providerType: string): boolean {
    return this.isPaid(providerType) && !this.granted.has(providerType);
  }

  hasConsent(providerType: string): boolean {
    return this.granted.has(providerType);
  }

  grantConsent(providerType: string): void {
    if (this.granted.has(providerType)) {
      return;
    }
    if (this.granted.size >= MAX_TRACKED) {
      // Evict the oldest tracked consent (insertion order) instead of
      // wiping every consent granted in this window.
      const oldest = this.granted.values().next().value;
      if (oldest !== undefined) {
        this.granted.delete(oldest);
      }
    }
    this.granted.add(providerType);
  }

  revokeConsent(providerType: string): void {
    this.granted.delete(providerType);
  }

  reset(): void {
    this.granted.clear();
  }
}
