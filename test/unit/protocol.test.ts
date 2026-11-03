import { expect } from 'chai';
import { parseWebviewMessage } from '../../src/chat/protocol';

suite('webview message parsing', () => {
  test('accepts every parameterless command', () => {
    const types = [
      'ready',
      'stop',
      'newChat',
      'attachSelection',
      'attachActiveFile',
      'attachFiles',
      'clearAttachments',
      'explainSelection',
      'setApiKey',
      'clearApiKey',
      'openSettings',
      'showLog',
      'refreshStatus',
    ] as const;

    for (const type of types) {
      expect(parseWebviewMessage({ type })).to.deep.equal({ type });
    }
  });

  test('parses a send message and preserves a valid mode', () => {
    expect(parseWebviewMessage({ type: 'send', prompt: 'Explain this', mode: 'explain' })).to.deep.equal({
      type: 'send',
      prompt: 'Explain this',
      mode: 'explain',
    });
  });

  test('falls back to ask for an unknown mode', () => {
    expect(parseWebviewMessage({ type: 'send', prompt: 'Hi', mode: 'hack' })).to.deep.equal({
      type: 'send',
      prompt: 'Hi',
      mode: 'ask',
    });
    expect(parseWebviewMessage({ type: 'send', prompt: 'Hi' })).to.deep.equal({
      type: 'send',
      prompt: 'Hi',
      mode: 'ask',
    });
  });

  test('rejects send messages without a prompt', () => {
    expect(parseWebviewMessage({ type: 'send', mode: 'ask' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'send', prompt: 42 })).to.equal(undefined);
  });

  test('accepts valid attachment removal ids', () => {
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 'attachment-1' })).to.deep.equal({
      type: 'removeAttachment',
      id: 'attachment-1',
    });
  });

  test('rejects malformed attachment removal ids', () => {
    expect(parseWebviewMessage({ type: 'removeAttachment' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: '' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 'x'.repeat(101) })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 7 })).to.equal(undefined);
  });

  test('ignores unknown, malformed and non-object messages', () => {
    expect(parseWebviewMessage({ type: 'runCommand', command: 'rm -rf /' })).to.equal(undefined);
    expect(parseWebviewMessage({})).to.equal(undefined);
    expect(parseWebviewMessage(undefined)).to.equal(undefined);
    expect(parseWebviewMessage(null)).to.equal(undefined);
    expect(parseWebviewMessage('ready')).to.equal(undefined);
    expect(parseWebviewMessage(42)).to.equal(undefined);
  });
});
