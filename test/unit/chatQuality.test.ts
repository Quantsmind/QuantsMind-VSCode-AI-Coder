import { expect } from 'chai';
import type { RedactedContextItem } from '../../src/context/filters';
import { buildMessages, buildSystemPrompt } from '../../src/chat/prompts';
import { buildChatLanguageGuidance } from '../../src/languages/prompts';

/**
 * Targeted quality coverage for Ask / Explain / Generate prompt construction.
 *
 * These tests cannot measure a provider's output, so they anchor the contract:
 * the prompt must preserve attachments verbatim, keep conversation order, and
 * carry the accuracy guardrails the v3.0.0 test cycle exposed as missing
 * (mid-code stopping, unverified claims, conflated facts and assumptions).
 * The Java 21 samples are from that same cycle.
 */

const JAVA21_RECORD = `public record OrderLine(String sku, int quantity) {
  public OrderLine {
    if (quantity <= 0) throw new IllegalArgumentException("quantity must be positive");
  }
}
`;

const JAVA21_VIRTUAL_THREAD = `private static final java.util.concurrent.Executors VIRTUAL = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor();

void fetchAll(List<URI> uris) throws InterruptedException, ExecutionException {
  try (var executor = VIRTUAL) {
    List<Future<String>> futures = uris.stream()
        .map(uri -> executor.submit(() -> fetch(uri)))
        .toList();
    for (Future<String> future : futures) {
      System.out.println(future.get());
    }
  }
}
`;

function attachment(path: string, content: string, languageId = 'java'): RedactedContextItem {
  return {
    path,
    content,
    languageId,
    isSelection: false,
    sizeBytes: content.length,
    redactions: 0,
  };
}

suite('chat prompt quality guardrails (v3.1.0)', () => {
  test('ask mode prompt demands facts vs assumptions and bans unverified execution claims', () => {
    const prompt = buildSystemPrompt('ask');
    expect(prompt).to.contain('Distinguish facts from assumptions');
    expect(prompt).to.contain('Never claim that code was compiled, tested, executed or applied unless it was');
    expect(prompt).to.contain('Never stop mid-method or mid-class without explanation');
  });

  test('explain mode prompt demands semantics, edge cases, security and anti-overstatement', () => {
    const prompt = buildSystemPrompt('explain');
    expect(prompt).to.contain('language semantics');
    expect(prompt).to.contain('edge cases');
    expect(prompt).to.contain('thread safety and security implications');
    expect(prompt).to.contain('ACTUALLY does');
    expect(prompt).to.contain('never overstate performance, concurrency or security properties');
    expect(prompt).to.contain('what the code ACTUALLY does');
  });

  test('generate mode prompt demands completeness, tests, documentation and honesty about verification', () => {
    const prompt = buildSystemPrompt('generate');
    expect(prompt).to.contain('complete, idiomatic code');
    expect(prompt).to.contain('tests, documentation and complexity analysis');
    expect(prompt).to.contain('Do not stop halfway through a class or method without saying so');
    expect(prompt).to.contain('Never imply the code has been compiled, tested or verified unless it was actually run');
    expect(prompt).to.contain('code has not been applied');
  });

  test('base prompt forbids claiming code was executed unless it was', () => {
    for (const mode of ['ask', 'explain', 'generate'] as const) {
      expect(buildSystemPrompt(mode)).to.contain('Never claim that code was compiled, tested, executed or applied unless it was');
    }
  });

  test('java attachments are preserved verbatim for the explain mode', () => {
    const messages = buildMessages({
      mode: 'explain',
      question: 'Explain this record and its compact constructor.',
      attachments: [attachment('src/main/java/OrderLine.java', JAVA21_RECORD)],
    });
    const user = messages[messages.length - 1];
    expect(user.role).to.equal('user');
    expect(user.content).to.contain('public record OrderLine');
    expect(user.content).to.contain('throw new IllegalArgumentException("quantity must be positive")');
    expect(user.content).to.contain('Explain this record');
  });

  test('java 21 virtual-thread attachment is preserved verbatim for the generate mode', () => {
    const messages = buildMessages({
      mode: 'generate',
      question: 'Complete the fetchAll method and add a JUnit 5 test.',
      attachments: [attachment('src/main/java/Fetcher.java', JAVA21_VIRTUAL_THREAD)],
    });
    const user = messages[messages.length - 1];
    expect(user.content).to.contain('Executors.newVirtualThreadPerTaskExecutor()');
    expect(user.content).to.contain('executor.submit');
    expect(user.content).to.contain('fetchAll');
  });

  test('conversation history is replayed in order and before the new request', () => {
    const history = [
      { role: 'user' as const, content: 'first question about records' },
      { role: 'assistant' as const, content: 'first answer about records' },
      { role: 'user' as const, content: 'follow-up about the compact constructor' },
      { role: 'assistant' as const, content: 'answer about the compact constructor' },
    ];
    const messages = buildMessages({
      mode: 'ask',
      question: 'and what about the canonical constructor?',
      attachments: [],
      history,
    });
    expect(messages.map((message) => message.role)).to.deep.equal([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[1].content).to.contain('records');
    expect(messages[4].content).to.contain('compact constructor');
    expect(messages[5].content).to.contain('canonical constructor');
  });

  test('local-only and empty assistant turns in history are not replayed', () => {
    const history = [
      { role: 'user' as const, content: 'real question' },
      { role: 'assistant' as const, content: '   ' },
      { role: 'assistant' as const, content: 'real answer' },
    ];
    const messages = buildMessages({
      mode: 'ask',
      question: 'next question',
      attachments: [],
      history,
    });
    expect(messages.map((message) => message.role)).to.deep.equal(['system', 'user', 'assistant', 'user']);
  });

  test('java chat language guidance mentions modern constructs and pinning', () => {
    const guidance = buildChatLanguageGuidance('java');
    expect(guidance).to.contain('Active language: Java.');
    expect(guidance).to.match(/records|pattern matching|virtual threads/i);
    expect(guidance).to.contain('pinning');
  });
});
