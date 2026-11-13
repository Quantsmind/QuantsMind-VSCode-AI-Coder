import { expect } from 'chai';
import { ChatSession } from '../../src/chat/session';
import { providerHistoryMessages } from '../../src/chat/attachmentContext';
import type { RestorableMessage } from '../../src/chat/attachmentContext';

/**
 * v3.1.1 WP1 — mode isolation between Ask/Explain/Generate and Agent provider replay.
 */
suite('ask/agent mode isolation (v3.1.1)', () => {
  test('ask and agent session snapshots exclude each other', () => {
    const session = new ChatSession(10_000);
    session.addUser('ask question', 'ask');
    session.addAssistant('ask answer', 'ask');
    session.addUser('agent requirement', 'agent');
    session.addAssistant('agent output', 'agent');

    expect(session.snapshotFor('ask').map((m) => m.content)).to.deep.equal(['ask question', 'ask answer']);
    expect(session.snapshotFor('agent').map((m) => m.content)).to.deep.equal(['agent requirement', 'agent output']);
    expect(session.snapshot().length).to.equal(4);
  });

  test('untagged legacy messages are replayed in ask scope only', () => {
    const session = new ChatSession(10_000);
    session.load([
      { role: 'user', content: 'legacy question' },
      { role: 'assistant', content: 'legacy answer' },
      { role: 'user', content: 'agent requirement', mode: 'agent' },
    ]);

    expect(session.snapshotFor('ask').map((m) => m.content)).to.deep.equal([
      'legacy question',
      'legacy answer',
    ]);
    expect(session.snapshotFor('agent').map((m) => m.content)).to.deep.equal([
      'agent requirement',
    ]);
  });

  test('providerHistoryMessages preserves mode tags for replay', () => {
    const messages: RestorableMessage[] = [
      { role: 'user', text: 'ask question', mode: 'ask' },
      { role: 'assistant', text: 'old ask answer', mode: 'ask' },
      { role: 'user', text: 'agent requirement', mode: 'agent' },
      { role: 'assistant', text: 'agent output', mode: 'agent' },
    ];
    const rebuilt = providerHistoryMessages(messages);
    expect(rebuilt.map((m) => m.mode)).to.deep.equal(['ask', 'ask', 'agent', 'agent']);

    const session = new ChatSession(10_000);
    session.load(rebuilt);
    expect(session.snapshotFor('ask').map((m) => m.content)).to.deep.equal([
      'ask question',
      'old ask answer',
    ]);
    expect(session.snapshotFor('agent').map((m) => m.content)).to.deep.equal([
      'agent requirement',
      'agent output',
    ]);
  });

  test('clearing ask scope removes only ask messages', () => {
    const session = new ChatSession(10_000);
    session.addUser('ask question', 'ask');
    session.addUser('agent requirement', 'agent');
    session.addAssistant('ask answer', 'ask');

    session.clearTransient('ask');
    expect(session.snapshotFor('ask')).to.have.length(0);
    expect(session.snapshotFor('agent').map((m) => m.content)).to.deep.equal([
      'agent requirement',
    ]);
  });
});
