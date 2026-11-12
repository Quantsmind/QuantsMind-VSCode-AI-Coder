import { expect } from 'chai';
import { PaidProviderConsent, PaidConsentError } from '../../src/providers/paidConsent';

suite('paid provider consent', () => {
  test('paid providers require explicit consent; free/local providers do not', () => {
    const consent = new PaidProviderConsent();

    expect(consent.isPaid('openai')).to.equal(true);
    expect(consent.isPaid('openrouter')).to.equal(true);
    expect(consent.isPaid('groq')).to.equal(false); // free tier, key required
    expect(consent.isPaid('pollinations')).to.equal(false); // anonymous free tier
    expect(consent.isPaid('ollama')).to.equal(false);
    expect(consent.isPaid('groq-local' as string)).to.equal(false); // unknown types are never assumed paid

    expect(consent.requiresConsent('openai')).to.equal(true);
    expect(consent.requiresConsent('ollama')).to.equal(false);
  });

  test('granting consent satisfies the gate; revoking re-arms it', () => {
    const consent = new PaidProviderConsent();

    consent.grantConsent('openrouter');
    expect(consent.requiresConsent('openrouter')).to.equal(false);
    expect(consent.hasConsent('openrouter')).to.equal(true);

    consent.revokeConsent('openrouter');
    expect(consent.requiresConsent('openrouter')).to.equal(true);

    consent.reset();
    expect(consent.hasConsent('openai')).to.equal(false);
  });

  test('PaidConsentError carries the provider and access class', () => {
    const error = new PaidConsentError('openai', 'paid');
    expect(error.providerType).to.equal('openai');
    expect(error.access).to.equal('paid');
    expect(error.message).to.contain('paid');
  });
});
