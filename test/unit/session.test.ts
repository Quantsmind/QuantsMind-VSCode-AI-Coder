import { expect } from 'chai';
import { ChatSession } from '../../src/chat/session';

suite('chat session history', () => {
  test('records user and assistant messages in order', () => {
    const session = new ChatSession(1000);
    session.addUser('question');
    session.addAssistant('answer');

    expect(session.snapshot()).to.deep.equal([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(session.charCount).to.equal('questionanswer'.length);
  });

  test('ignores empty user messages and blank assistant messages', () => {
    const session = new ChatSession(1000);
    session.addUser('');
    session.addAssistant('   ');

    expect(session.snapshot()).to.deep.equal([]);
  });

  test('trims the oldest messages when the character budget is exceeded', () => {
    const session = new ChatSession(20);
    session.addUser('1234567890');
    session.addAssistant('1234567890');
    session.addUser('1234567890');

    expect(session.snapshot()).to.deep.equal([
      { role: 'assistant', content: '1234567890' },
      { role: 'user', content: '1234567890' },
    ]);
    expect(session.charCount).to.equal(20);
  });

  test('always keeps the most recent message even when it exceeds the budget', () => {
    const session = new ChatSession(5);
    session.addUser('this message is much longer than the budget');

    expect(session.snapshot()).to.have.length(1);
    expect(session.snapshot()[0].content).to.equal('this message is much longer than the budget');
  });

  test('returns snapshots that cannot mutate internal state', () => {
    const session = new ChatSession(1000);
    session.addUser('original');
    const snapshot = session.snapshot() as { role: string; content: string }[];
    snapshot[0].content = 'mutated';

    expect(session.snapshot()[0].content).to.equal('original');
  });

  test('clears all history', () => {
    const session = new ChatSession(1000);
    session.addUser('question');
    session.clear();

    expect(session.snapshot()).to.deep.equal([]);
    expect(session.charCount).to.equal(0);
  });
});
