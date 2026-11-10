import { expect } from 'chai';
import {
  ATTACHMENT_TRUNCATION_MARKER,
  MAX_ATTACHMENT_CONTEXT_CHARS_PER_CONVERSATION,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../../src/config/defaults';
import {
  attachmentRestoreWarnings,
  captureAttachments,
  checksumOf,
  displaysForStoredAttachments,
  enforceAttachmentBudget,
  freshnessOf,
  parseAttachmentContext,
  providerContentFor,
  providerHistoryMessages,
  restoreAttachmentContext,
  withheldAttachmentCount,
  type StoredAttachment,
} from '../../src/chat/attachmentContext';
import { buildUserContent } from '../../src/chat/prompts';
import type { RedactedContextItem } from '../../src/context/filters';

const CAPTURED_AT = '2026-11-04T00:00:00.000Z';

function contextItem(
  path: string,
  content: string,
  overrides: Partial<RedactedContextItem> = {},
): RedactedContextItem {
  return {
    path,
    content,
    languageId: 'typescript',
    isSelection: false,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    redactions: 0,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredAttachment> = {}): StoredAttachment {
  const content = overrides.content ?? 'export const value = 1;';
  return {
    path: 'src/a.ts',
    content,
    chars: content.length,
    checksum: checksumOf(content),
    languageId: 'typescript',
    isSelection: false,
    startLine: undefined,
    endLine: undefined,
    redactions: 0,
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

suite('captured attachment context', () => {
  test('reconstructs the exact provider content of the original turn', () => {
    const items = [
      contextItem('src/a.ts', 'export const a = 1;\n'),
      contextItem('src/b.ts', 'function b() { return 2; }\n', {
        isSelection: true,
        startLine: 3,
        endLine: 9,
      }),
    ];
    const captured = captureAttachments(items, CAPTURED_AT);
    expect(captured.captured).to.have.lengthOf(2);
    expect(captured.dropped).to.deep.equal([]);
    expect(captured.chars).to.equal(items[0].content.length + items[1].content.length);

    const original = buildUserContent('Explain these two files.', items);
    const rebuilt = providerContentFor({
      role: 'user',
      text: 'Explain these two files.',
      question: 'Explain these two files.',
      attachmentContext: captured.captured,
    });

    expect(rebuilt).to.equal(original);
    expect(rebuilt).to.contain('User request:\nExplain these two files.');
    expect(rebuilt).to.contain('src/b.ts');
  });

  test('keeps the verbatim prompt when the displayed text is a fallback', () => {
    const items = [contextItem('src/a.ts', 'const a = 1;')];
    const captured = captureAttachments(items, CAPTURED_AT);
    const rebuilt = providerContentFor({
      role: 'user',
      text: 'What does this do?',
      question: '',
      attachmentContext: captured.captured,
    });

    expect(rebuilt).to.equal(buildUserContent('', items));
    expect(rebuilt).to.contain('User request:\nHelp me with the attached code.');
  });

  test('truncates beyond the per-message budget and reports what was dropped', () => {
    const huge = 'x'.repeat(40_000);
    const captured = captureAttachments([contextItem('src/huge.ts', huge)], CAPTURED_AT, 8_000);

    expect(captured.captured).to.have.lengthOf(1);
    const content = captured.captured[0].content;
    expect(content.length).to.equal(8_000);
    expect(content.endsWith(ATTACHMENT_TRUNCATION_MARKER)).to.equal(true);
    expect(captured.captured[0].chars).to.equal(huge.length);
    expect(captured.captured[0].checksum).to.equal(checksumOf(content));

    const zeroBudget = captureAttachments(
      [contextItem('src/a.ts', 'const a = 1;')],
      CAPTURED_AT,
      0,
    );
    expect(zeroBudget.captured).to.deep.equal([]);
    expect(zeroBudget.dropped).to.deep.equal(['src/a.ts']);
  });

  test('caps the number of captured attachments per message', () => {
    const items = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 10 }, (_unused, index) =>
      contextItem(`src/f${index}.ts`, `const v${index} = ${index};`),
    );
    const captured = captureAttachments(items, CAPTURED_AT, 400_000);
    expect(captured.captured).to.have.lengthOf(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(captured.dropped).to.have.lengthOf(10);
  });

  test('restores only content that is actually present', () => {
    const restored = restoreAttachmentContext([
      stored({ path: 'src/a.ts' }),
      stored({ path: 'src/gone.ts', content: '' }),
    ]);
    expect(restored.items).to.have.lengthOf(1);
    expect(restored.items[0].path).to.equal('src/a.ts');
    expect(restored.unavailable.map((item) => item.path)).to.deep.equal(['src/gone.ts']);
    expect(restored.chars).to.equal('export const value = 1;'.length);
  });

  test('parses persisted attachment metadata strictly and order-preservingly', () => {
    const parsed = parseAttachmentContext([
      stored({ path: 'src/first.ts' }),
      'not-an-object',
      { content: 'missing path' },
      { path: '   ', content: 'blank path' },
      { path: 'src/second.ts', content: 'const b = 2;', chars: 'bad', checksum: 'ZZZ' },
      null,
      [],
    ]);

    expect(parsed.map((item) => item.path)).to.deep.equal(['src/first.ts', 'src/second.ts']);
    const second = parsed[1];
    expect(second.chars).to.equal('const b = 2;'.length);
    expect(second.checksum).to.equal(checksumOf('const b = 2;'));
    expect(second.redactions).to.equal(0);
    expect(second.isSelection).to.equal(false);
  });

  test('releases the oldest captured content first when the conversation budget is exceeded', () => {
    const messages = [
      { role: 'user' as const, text: 'first', attachmentContext: [stored({ path: 'src/1.ts', content: 'a'.repeat(40_000) })] },
      { role: 'assistant' as const, text: 'reply' },
      { role: 'user' as const, text: 'second', attachmentContext: [stored({ path: 'src/2.ts', content: 'b'.repeat(40_000) })] },
      { role: 'user' as const, text: 'third', attachmentContext: [stored({ path: 'src/3.ts', content: 'c'.repeat(40_000) })] },
    ];

    const result = enforceAttachmentBudget(messages, MAX_ATTACHMENT_CONTEXT_CHARS_PER_CONVERSATION);
    expect(result.releasedAttachments).to.equal(1);
    expect(result.releasedChars).to.equal(40_000);
    expect(result.messages.map((message) => message.text)).to.deep.equal([
      'first',
      'reply',
      'second',
      'third',
    ]);
    expect(result.messages[0].attachmentContext?.[0].content).to.equal('');
    expect(result.messages[0].attachmentContext?.[0].path).to.equal('src/1.ts');
    expect(result.messages[2].attachmentContext?.[0].content).to.have.lengthOf(40_000);

    const untouched = enforceAttachmentBudget(messages, 200_000);
    expect(untouched.releasedAttachments).to.equal(0);
    expect(untouched.messages).to.deep.equal(messages);
  });

  test('labels captured, unavailable and legacy attachment context distinctly', () => {
    const displays = displaysForStoredAttachments(
      [stored({ path: 'src/a.ts' }), stored({ path: 'src/b.ts', content: '' })],
      ['src/legacy.ts'],
    );
    expect(displays.map((display) => display.status)).to.deep.equal([
      'captured',
      'unavailable',
      'legacy',
    ]);
    expect(displays[0].chars).to.equal('export const value = 1;'.length);
    expect(displays[1].chars).to.equal(0);

    const warnings = attachmentRestoreWarnings(displays);
    expect(warnings).to.have.lengthOf(2);
    expect(warnings[0]).to.contain('could not be restored');
    expect(warnings[1]).to.contain('stored only a path');
  });

  test('never double-reports a path that has captured context', () => {
    const displays = displaysForStoredAttachments([stored({ path: 'src/a.ts' })], ['src/a.ts']);
    expect(displays).to.have.lengthOf(1);
    expect(displays[0].status).to.equal('captured');
  });

  test('compares captured context with the current file without substituting it', () => {
    const captured = stored({ path: 'src/a.ts', content: 'const a = 1;' });
    expect(freshnessOf(captured, 'const a = 1;')).to.equal('unchanged');
    expect(freshnessOf(captured, 'const a = 2;')).to.equal('modified');
    expect(freshnessOf(captured, undefined)).to.equal('missing');
    expect(freshnessOf(stored({ content: '' }), 'whatever')).to.equal('unknown');
  });

  test('rebuilds provider history in order, skipping local-only and empty turns', () => {
    const rebuilt = providerHistoryMessages([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'assistant', text: 'Workspace summary (local index)', localOnly: true },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: '' },
    ]);

    expect(rebuilt).to.deep.equal([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
  });

  test('legacy records without a captured question replay their stored text', () => {
    expect(providerContentFor({ role: 'user', text: 'What does this do?' })).to.equal(
      'What does this do?',
    );
    expect(providerContentFor({ role: 'user', text: '', localOnly: true })).to.equal(undefined);
  });

  test('records who selected each piece of captured content', () => {
    const explicit = captureAttachments([contextItem('src/a.ts', 'const a = 1;')], CAPTURED_AT);
    const discovered = captureAttachments(
      [contextItem('src/b.ts', 'const b = 1;', { origin: 'workspace' })],
      CAPTURED_AT,
    );

    expect(explicit.captured[0].origin).to.equal('user');
    expect(discovered.captured[0].origin).to.equal('workspace');
  });

  test('treats stored attachments without provenance as automatically discovered', () => {
    const [legacy] = parseAttachmentContext([{ path: 'src/a.ts', content: 'const a = 1;' }]);
    const [explicit] = parseAttachmentContext([
      { path: 'src/a.ts', content: 'const a = 1;', origin: 'user' },
    ]);

    expect(legacy.origin).to.equal('workspace');
    expect(explicit.origin).to.equal('user');
  });

  test('withholds discovered context but replays explicit attachments while restricted', () => {
    const messages = [
      {
        role: 'user' as const,
        text: 'discovered turn',
        question: 'discovered turn',
        attachmentContext: [
          stored({ path: 'src/auto.ts', content: 'const auto = 1;', origin: 'workspace' }),
        ],
      },
      {
        role: 'user' as const,
        text: 'chosen turn',
        question: 'chosen turn',
        attachmentContext: [
          stored({ path: 'src/mine.ts', content: 'const mine = 1;', origin: 'user' }),
        ],
      },
    ];

    const restricted = providerHistoryMessages(messages, { includeAutoDiscovered: false });

    expect(restricted).to.deep.equal([
      { role: 'user', content: 'discovered turn' },
      {
        role: 'user',
        content: buildUserContent('chosen turn', [
          contextItem('src/mine.ts', 'const mine = 1;', { origin: 'user' }),
        ]),
      },
    ]);
    expect(restricted[1].content).to.contain('const mine = 1;');
    expect(restricted.map((message) => message.content).join('\n')).to.not.contain(
      'const auto = 1;',
    );
    expect(withheldAttachmentCount(messages)).to.equal(1);

    const restored = restoreAttachmentContext(messages[0].attachmentContext, {
      includeAutoDiscovered: false,
    });
    expect(restored.items).to.deep.equal([]);
    expect(restored.withheld.map((attachment) => attachment.path)).to.deep.equal(['src/auto.ts']);
  });

  test('replays every stored attachment when the workspace is trusted', () => {
    const messages = [
      {
        role: 'user' as const,
        text: 'both',
        question: 'both',
        attachmentContext: [
          stored({ path: 'src/auto.ts', content: 'const auto = 1;', origin: 'workspace' }),
          stored({ path: 'src/mine.ts', content: 'const mine = 1;', origin: 'user' }),
        ],
      },
    ];

    const rebuilt = providerHistoryMessages(messages, { includeAutoDiscovered: true });
    expect(rebuilt[0].content).to.contain('const auto = 1;');
    expect(rebuilt[0].content).to.contain('const mine = 1;');
    expect(withheldAttachmentCount(messages)).to.equal(1);
  });
});
