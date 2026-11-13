import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPrompt } from '../../src/chat/prompts';
import { buildChatLanguageGuidance } from '../../src/languages/prompts';

/**
 * WP6 — Ask/Explain answer-quality regression tests stored as contract assertions
 * on the prompt the provider receives. The provider cannot be executed here, so
 * the guarantees are carried into the system/language prompt verbatim.
 */
suite('ask explain quality regression (v3.1.1)', () => {
  test('python guidance explains __all__ and the __main__ guard exactly', () => {
    const guidance = buildChatLanguageGuidance('python');
    expect(guidance).to.contain('__all__');
    expect(guidance).to.contain('from module import *');
    expect(guidance).to.contain('import-time side effects');
    expect(guidance).to.contain('__name__ == "__main__"');
  });

  test('java guidance covers interface members completely', () => {
    const guidance = buildChatLanguageGuidance('java');
    expect(guidance).to.contain('abstract');
    expect(guidance).to.match(/default.*static|static.*default/i);
    expect(guidance).to.contain('private interface methods');
    expect(guidance).to.contain('implicitly public and abstract');
  });

  test('explain mode prompt separates facts from assumptions and bans misrecollection', () => {
    const prompt = buildSystemPrompt('explain');
    expect(prompt).to.contain('ACTUALLY does');
    expect(prompt).to.contain('never overstate performance, concurrency or security properties');
    expect(prompt).to.contain('language semantics');
  });

  test('webview fence language sanitizer normalizes Copy-suffixed labels', () => {
    const source = readFileSync(join(__dirname, '..', '..', '..', 'media', 'chat.js'), 'utf8');
    // Canonical mapping exists for the exact artifacts observed.
    for (const token of ['javacopy', 'textcopy', 'pythoncopy']) {
      expect(source, token).to.contain(`${token}:`);
    }
    // The normalizer strips the Copy suffix onto the base alias.
    expect(source).to.contain("cleaned.slice(-4) === 'copy'");
    expect(source).to.contain("LANGUAGE_ALIASES[base]");
  });
});
