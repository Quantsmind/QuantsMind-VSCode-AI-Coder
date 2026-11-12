import { expect } from 'chai';
import { resolveLanguageIntelligenceSettings } from '../../src/config/resolve';

suite('language intelligence settings', () => {
  test('defaults to enabled', () => {
    expect(resolveLanguageIntelligenceSettings({}).enabled).to.equal(true);
    expect(resolveLanguageIntelligenceSettings({ enabled: undefined }).enabled).to.equal(true);
  });

  test('honors an explicit boolean', () => {
    expect(resolveLanguageIntelligenceSettings({ enabled: false }).enabled).to.equal(false);
    expect(resolveLanguageIntelligenceSettings({ enabled: true }).enabled).to.equal(true);
  });

  test('non-boolean values fall back to the default instead of guessing', () => {
    expect(resolveLanguageIntelligenceSettings({ enabled: 'yes' as unknown as boolean }).enabled).to.equal(true);
    expect(resolveLanguageIntelligenceSettings({ enabled: 0 as unknown as boolean }).enabled).to.equal(true);
  });
});
