import { expect } from 'chai';
import {
  CONVERSATION_STORAGE_KEY,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATIONS,
} from '../../src/config/defaults';
import {
  ConversationStore,
  type Conversation,
  type StoredMessage,
} from '../../src/chat/persistence';

class MemoryMemento {
  readonly values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function message(role: 'user' | 'assistant', text: string): StoredMessage {
  return { role, text, attachments: [], createdAt: new Date().toISOString() };
}

function conversation(id: string, messages: StoredMessage[] = []): Conversation {
  const now = new Date().toISOString();
  return { id, title: 'New chat', createdAt: now, updatedAt: now, messages };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

suite('conversation persistence', () => {
  test('starts empty and reports created conversations', () => {
    const store = new ConversationStore(new MemoryMemento());
    expect(store.list()).to.deep.equal([]);
    expect(store.get('missing')).to.equal(undefined);

    const created = store.create();
    expect(created.id).to.match(/^conversation-/);
    expect(created.title).to.equal('New chat');
    expect(created.messages).to.deep.equal([]);
  });

  test('derives a title from the first user message and marks it active', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    const saved = await store.save(
      conversation('c1', [
        message('assistant', 'Welcome'),
        message('user', '  Fix   the   provider   timeout  '),
        message('assistant', 'Done'),
      ]),
    );

    expect(saved.title).to.equal('Fix the provider timeout');
    expect(store.activeId()).to.equal('c1');
    expect(store.list()).to.deep.equal([
      {
        id: 'c1',
        title: 'Fix the provider timeout',
        updatedAt: saved.updatedAt,
        messageCount: 3,
      },
    ]);
    expect(memento.get(CONVERSATION_STORAGE_KEY)).to.be.an('array');
  });

  test('truncates long titles to 80 characters', async () => {
    const store = new ConversationStore(new MemoryMemento());
    const saved = await store.save(
      conversation('c1', [message('user', 'w'.repeat(200))]),
    );
    expect(saved.title).to.have.length(80);
  });

  test('updates an existing conversation instead of duplicating it', async () => {
    const store = new ConversationStore(new MemoryMemento());
    await store.save(conversation('c1', [message('user', 'first')]));
    await tick();
    await store.save(conversation('c1', [message('user', 'first'), message('assistant', 'second')]));

    expect(store.list()).to.have.length(1);
    expect(store.get('c1')?.messages).to.have.length(2);
  });

  test('lists the most recently saved conversation first', async () => {
    const store = new ConversationStore(new MemoryMemento());
    await store.save(conversation('a', [message('user', 'alpha')]));
    await tick();
    await store.save(conversation('b', [message('user', 'beta')]));
    expect(store.list().map((item) => item.id)).to.deep.equal(['b', 'a']);

    await tick();
    await store.save(conversation('a', [message('user', 'alpha'), message('assistant', 'again')]));
    expect(store.list().map((item) => item.id)).to.deep.equal(['a', 'b']);
  });

  test('deletes conversations and moves the active pointer', async () => {
    const store = new ConversationStore(new MemoryMemento());
    await store.save(conversation('a', [message('user', 'alpha')]));
    await tick();
    await store.save(conversation('b', [message('user', 'beta')]));

    await store.delete('b');
    expect(store.list().map((item) => item.id)).to.deep.equal(['a']);
    expect(store.activeId()).to.equal('a');

    await store.delete('a');
    expect(store.list()).to.deep.equal([]);
    expect(store.activeId()).to.equal(undefined);
  });

  test('keeps only the newest messages up to the count limit', async () => {
    const store = new ConversationStore(new MemoryMemento());
    const messages = Array.from({ length: 205 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', `m${index}`),
    );
    const saved = await store.save(conversation('c1', messages));
    expect(saved.messages).to.have.length(200);
    expect(saved.messages[0].text).to.equal('m5');
    expect(saved.messages[199].text).to.equal('m204');
  });

  test('drops oldest messages when the character budget is exceeded', async () => {
    const store = new ConversationStore(new MemoryMemento());
    const chunk = Math.floor(MAX_CONVERSATION_CHARS / 3) + 1;
    const saved = await store.save(
      conversation('c1', [
        message('user', 'a'.repeat(chunk)),
        message('assistant', 'b'.repeat(chunk)),
        message('user', 'c'.repeat(chunk)),
      ]),
    );
    expect(saved.messages).to.have.length(2);
    expect(saved.messages[0].text.startsWith('b')).to.equal(true);
  });

  test('always keeps the most recent message even when it exceeds the budget', async () => {
    const store = new ConversationStore(new MemoryMemento());
    const saved = await store.save(
      conversation('c1', [
        message('user', 'small'),
        message('assistant', 'z'.repeat(MAX_CONVERSATION_CHARS + 1_000)),
      ]),
    );
    expect(saved.messages).to.have.length(1);
    expect(saved.messages[0].text).to.have.length(MAX_CONVERSATION_CHARS + 1_000);
  });

  test('caps the number of stored conversations', async () => {
    const store = new ConversationStore(new MemoryMemento());
    for (let index = 0; index < MAX_CONVERSATIONS + 3; index += 1) {
      await store.save(conversation(`c${index}`, [message('user', `prompt ${index}`)]));
    }
    expect(store.list()).to.have.length(MAX_CONVERSATIONS);
    expect(store.get('c0')).to.equal(undefined);
  });

  test('ignores malformed stored entries', () => {
    const memento = new MemoryMemento();
    memento.values.set(CONVERSATION_STORAGE_KEY, [
      { id: 'valid', title: 't', createdAt: 'now', updatedAt: 'now', messages: [] },
      { id: 42, title: 'bad' },
      null,
      { id: 'other', title: 't', createdAt: 'now', messages: 'not-an-array' },
    ]);
    const store = new ConversationStore(memento);
    expect(store.list().map((item) => item.id)).to.deep.equal(['valid']);
  });

  test('sanitizes malformed messages inside a stored conversation', () => {
    const memento = new MemoryMemento();
    memento.values.set(CONVERSATION_STORAGE_KEY, [
      {
        id: 'c1',
        title: 't',
        createdAt: 'now',
        updatedAt: 'now',
        messages: [
          { role: 'system', text: 'dropped' },
          { role: 'user', text: 42 },
          { role: 'user', text: 'kept', attachments: ['a.ts', 7, 'b.ts'] },
        ],
      },
    ]);
    const stored = new ConversationStore(memento).get('c1');
    expect(stored?.messages).to.deep.equal([
      {
        role: 'user',
        text: 'kept',
        attachments: ['a.ts', 'b.ts'],
        createdAt: new Date(0).toISOString(),
      },
    ]);
  });
});
