import { expect } from 'chai';
import { formatRequestBreakdown, measureRequest } from '../../src/chat/requestMetrics';
import { parseWebviewMessage } from '../../src/chat/protocol';
import type { ChatMessage } from '../../src/providers/types';

const SYSTEM = 'You are a careful coding assistant.';
const HISTORY = ['What does this do?', 'It reads a file.'];
const PROMPT = 'Now explain the test.';
const ATTACHMENT = 'const value = 1;\n';

function messages(): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    ...HISTORY.map((content, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content,
    })),
    {
      role: 'user',
      content: `<attached_context>${ATTACHMENT}</attached_context>\nUser request:\n${PROMPT}`,
    },
  ];
}

suite('request diagnostics', () => {
  test('separates system instructions, replayed history, the prompt and the last message', () => {
    const breakdown = measureRequest(messages(), {
      promptChars: PROMPT.length,
      attachmentItems: 1,
      attachmentChars: ATTACHMENT.length,
    });

    expect(breakdown.messages).to.equal(4);
    expect(breakdown.systemChars).to.equal(SYSTEM.length);
    expect(breakdown.historyMessages).to.equal(2);
    expect(breakdown.historyChars).to.equal(HISTORY[0].length + HISTORY[1].length);
    expect(breakdown.promptChars).to.equal(PROMPT.length);
    expect(breakdown.attachmentItems).to.equal(1);
    expect(breakdown.attachmentChars).to.equal(ATTACHMENT.length);
    expect(breakdown.totalChars).to.equal(
      messages().reduce((sum, message) => sum + message.content.length, 0),
    );
  });

  test('reports an empty history for the first turn of a new conversation', () => {
    const breakdown = measureRequest(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: PROMPT },
      ],
      { promptChars: PROMPT.length, attachmentItems: 0, attachmentChars: 0 },
    );

    expect(breakdown.historyMessages).to.equal(0);
    expect(breakdown.historyChars).to.equal(0);
    expect(breakdown.messages).to.equal(2);
  });

  test('emits sizes only, never the request content', () => {
    const line = formatRequestBreakdown(
      measureRequest(messages(), {
        promptChars: PROMPT.length,
        attachmentItems: 1,
        attachmentChars: ATTACHMENT.length,
      }),
    );

    expect(line).to.contain('messages=4');
    expect(line).to.contain('historyMessages=2');
    expect(line).to.contain(`promptChars=${PROMPT.length}`);
    expect(line).to.not.contain(PROMPT);
    expect(line).to.not.contain(SYSTEM);
    expect(line).to.not.contain('const value');
    expect(line.split('\n')).to.have.lengthOf(1);
  });

  test('accepts the new conversation-management messages from the webview', () => {
    expect(parseWebviewMessage({ type: 'clearConversation' })).to.deep.equal({
      type: 'clearConversation',
    });
    expect(parseWebviewMessage({ type: 'restorePreviousConversation' })).to.deep.equal({
      type: 'restorePreviousConversation',
    });
    expect(
      parseWebviewMessage({ type: 'restorePreviousConversation', id: 'conversation-abc-123' }),
    ).to.deep.equal({ type: 'restorePreviousConversation', id: 'conversation-abc-123' });
    expect(parseWebviewMessage({ type: 'restorePreviousConversation', id: '' })).to.equal(undefined);
    expect(
      parseWebviewMessage({ type: 'restorePreviousConversation', id: 42 }),
    ).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'unknownAction' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'clearConversation', inject: 'x' })).to.deep.equal({
      type: 'clearConversation',
    });
  });
});
