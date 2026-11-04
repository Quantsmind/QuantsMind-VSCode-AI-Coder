import { expect } from 'chai';
import {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_STORAGE_KEY,
  MAX_CONVERSATIONS,
} from '../../src/config/defaults';
import { checksumOf, type StoredAttachment } from '../../src/chat/attachmentContext';
import {
  ConversationStore,
  type Conversation,
  type StoredMessage,
} from '../../src/chat/persistence';

const UNREADABLE_KEY = `${CONVERSATION_STORAGE_KEY}.unreadable.v1`;

class MemoryMemento {
  readonly values = new Map<string, unknown>();
  failNextUpdate = false;

  get(key: string): unknown {
    return this.values.get(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('storage write interrupted');
    }
    this.values.set(key, value);
  }

  /** Raw list exactly as a previous release would have written it. */
  seed(value: unknown): void {
    this.values.set(CONVERSATION_STORAGE_KEY, value);
  }
}

function legacyMessage(role: 'user' | 'assistant', text: string, attachments: string[] = []): Record<string, unknown> {
  return {
    role,
    text,
    attachments,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function legacyConversation(id: string, messages: unknown[], updatedAt: string): Record<string, unknown> {
  return {
    id,
    title: 'New chat',
    createdAt: updatedAt,
    updatedAt,
    messages,
  };
}

function conversation(id: string, messages: StoredMessage[] = []): Conversation {
  const now = '2026-11-04T00:00:00.000Z';
  return { id, title: 'New chat', createdAt: now, updatedAt: now, messages };
}

function userMessage(text: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    role: 'user',
    text,
    attachments: [],
    createdAt: '2026-11-04T00:00:00.000Z',
    ...extra,
  };
}

function attachment(path: string, content: string): StoredAttachment {
  return {
    path,
    content,
    chars: content.length,
    checksum: checksumOf(content),
    languageId: 'typescript',
    isSelection: false,
    redactions: 0,
    capturedAt: '2026-11-04T00:00:00.000Z',
  };
}

suite('conversation persistence migration (v0.3.4)', () => {
  test('reads pre-0.3.4 records without a schema marker and upgrades them on write', () => {
    const memento = new MemoryMemento();
    memento.seed([
      legacyConversation('old-1', [legacyMessage('user', 'What does this do?'), legacyMessage('assistant', 'It parses.')], '2026-10-02T00:00:00.000Z'),
      legacyConversation('old-2', [legacyMessage('user', 'Refactor please', ['src/a.ts'])], '2026-10-01T00:00:00.000Z'),
    ]);

    const store = new ConversationStore(memento);
    expect(store.list().map((entry) => entry.id)).to.deep.equal(['old-1', 'old-2']);
    expect(store.get('old-1')?.schema).to.equal(1);
    expect(store.get('old-2')?.messages[0].attachments).to.deep.equal(['src/a.ts']);
    expect(store.get('old-2')?.messages[0].attachmentContext).to.equal(undefined);

    const saved = store.create();
    expect(saved.schema).to.equal(CONVERSATION_SCHEMA_VERSION);
  });

  test('keeps original message order and rejects malformed records without losing the rest', () => {
    const memento = new MemoryMemento();
    memento.seed([
      legacyConversation('mixed', [
        legacyMessage('user', 'one'),
        { role: 'tool', text: 'bad role' },
        legacyMessage('assistant', 'two'),
        'garbage',
        legacyMessage('user', 'three'),
      ], '2026-10-03T00:00:00.000Z'),
    ]);

    const store = new ConversationStore(memento);
    const loaded = store.get('mixed');
    expect(loaded?.messages.map((message) => message.text)).to.deep.equal(['one', 'two', 'three']);
    expect(loaded?.messages.map((message) => message.role)).to.deep.equal([
      'user',
      'assistant',
      'user',
    ]);
  });

  test('salvages a conversation record that cannot be parsed before rewriting the list', async () => {
    const memento = new MemoryMemento();
    memento.seed([
      { id: 'half-written', title: 'Interrupted save' },
      legacyConversation('good', [legacyMessage('user', 'hello')], '2026-10-04T00:00:00.000Z'),
    ]);

    const store = new ConversationStore(memento);
    expect(store.list().map((entry) => entry.id)).to.deep.equal(['good']);

    await store.save(conversation('fresh', [userMessage('new turn')]));

    const salvaged = memento.get(UNREADABLE_KEY);
    expect(Array.isArray(salvaged)).to.equal(true);
    expect((salvaged as unknown[]).length).to.equal(1);
    expect((salvaged as Record<string, unknown>[])[0].id).to.equal('half-written');
    expect(store.list().map((entry) => entry.id)).to.deep.equal(['fresh', 'good']);
  });

  test('writes captured attachment context and reads it back unchanged', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    const content = 'export const secretValue = 1;\n';
    const saved = await store.save(
      conversation('attach-1', [
        userMessage('Explain src/a.ts', {
          question: 'Explain src/a.ts',
          attachments: ['src/a.ts'],
          attachmentContext: [attachment('src/a.ts', content)],
        }),
      ]),
    );
    expect(saved.schema).to.equal(CONVERSATION_SCHEMA_VERSION);

    const reloaded = new ConversationStore(memento).get('attach-1');
    const restored = reloaded?.messages[0].attachmentContext;
    expect(restored?.map((item) => item.path)).to.deep.equal(['src/a.ts']);
    expect(restored?.[0].content).to.equal(content);
    expect(restored?.[0].checksum).to.equal(checksumOf(content));
    expect(memento.get(CONVERSATION_STORAGE_KEY)).to.be.an('array').with.lengthOf(1);
  });

  test('clear() empties one conversation and leaves the others untouched', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    await store.save(conversation('a', [userMessage('keep me')]));
    await store.save(conversation('b', [userMessage('first'), userMessage('second')]));

    const cleared = await store.clear('b');
    expect(cleared?.messages).to.deep.equal([]);
    expect(store.get('a')?.messages.map((message) => message.text)).to.deep.equal(['keep me']);
    expect(store.list().find((entry) => entry.id === 'b')?.messageCount).to.equal(0);
    expect(store.activeId()).to.equal('b');
  });

  test('mostRecent() skips empty conversations so restore cannot land on a blank chat', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    await store.save(conversation('first', [userMessage('one')]));
    await store.save(conversation('second', [userMessage('two')]));

    expect(store.mostRecent('second')?.id).to.equal('first');
    expect(store.mostRecent('first')?.id).to.equal('second');
    expect(store.mostRecent('missing')?.id).to.equal('second');

    const blank = store.create();
    await store.save(blank);
    expect(store.mostRecent(blank.id)?.id).to.equal('second');

    await store.clear('first');
    expect(store.mostRecent('second')).to.equal(undefined);
    expect(store.list().map((entry) => entry.id)).to.include('first');
  });

  test('an empty conversation keeps its previous position instead of jumping the history queue', async () => {
    const memento = new MemoryMemento();
    memento.seed([
      legacyConversation('old-one', [legacyMessage('user', 'one')], '2026-10-05T00:00:00.000Z'),
      legacyConversation('newer-one', [legacyMessage('user', 'two')], '2026-10-06T00:00:00.000Z'),
    ]);
    const store = new ConversationStore(memento);

    await store.clear('old-one');

    expect(store.get('old-one')?.updatedAt).to.equal('2026-10-05T00:00:00.000Z');
    expect(store.list().map((entry) => entry.id)).to.deep.equal(['newer-one', 'old-one']);
    expect(store.activeId()).to.equal('old-one');
    expect(store.mostRecent('old-one')?.id).to.equal('newer-one');
  });

  test('a failed storage write surfaces to the caller instead of silently dropping history', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    await store.save(conversation('ok', [userMessage('persisted')]));
    memento.failNextUpdate = true;

    let failure: unknown;
    try {
      await store.save(conversation('ok', [userMessage('persisted'), userMessage('lost')]));
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(store.get('ok')?.messages.map((message) => message.text)).to.deep.equal(['persisted']);
  });

  test('caps stored conversations and keeps the newest first', async () => {
    const memento = new MemoryMemento();
    const seed: Record<string, unknown>[] = [];
    for (let index = 0; index < MAX_CONVERSATIONS + 5; index += 1) {
      const stamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
      seed.push(legacyConversation(`c${index}`, [legacyMessage('user', `turn ${index}`)], stamp));
    }
    memento.seed(seed);

    const store = new ConversationStore(memento);
    expect(store.list()).to.have.lengthOf(MAX_CONVERSATIONS);
    expect(store.list()[0].id).to.equal(`c${MAX_CONVERSATIONS + 4}`);

    await store.save(conversation('newest', [userMessage('hi')]));
    expect(store.list()).to.have.lengthOf(MAX_CONVERSATIONS);
    expect(store.list()[0].id).to.equal('newest');
  });

  test('drops the oldest attachment content when a conversation exceeds its capture budget', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    const big = 'y'.repeat(40_000);
    const saved = await store.save(
      conversation('budget', [
        userMessage('oldest', { attachmentContext: [attachment('src/oldest.ts', big)] }),
        userMessage('middle', { attachmentContext: [attachment('src/middle.ts', big)] }),
        userMessage('newest', { attachmentContext: [attachment('src/newest.ts', big)] }),
        userMessage('even newer', { attachmentContext: [attachment('src/newer.ts', big)] }),
        userMessage('latest', { attachmentContext: [attachment('src/latest.ts', big)] }),
      ]),
    );

    const contents = saved.messages.map((message) => message.attachmentContext?.[0].content ?? '');
    expect(contents[0]).to.equal('');
    expect(contents[0].length).to.be.lessThan(big.length);
    expect(contents[contents.length - 1]).to.have.lengthOf(big.length);
    expect(saved.messages.map((message) => message.text)).to.deep.equal([
      'oldest',
      'middle',
      'newest',
      'even newer',
      'latest',
    ]);
    expect(saved.messages[0].attachmentContext?.[0].path).to.equal('src/oldest.ts');
  });

  test('preserves local-only markers and verbatim questions through a round trip', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    await store.save(
      conversation('mixed', [
        userMessage('What does this do?', { question: '  What does this do?  ' }),
        {
          role: 'assistant',
          text: 'Workspace summary (local index)',
          attachments: [],
          localOnly: true,
          createdAt: '2026-11-04T00:00:00.000Z',
        },
      ]),
    );

    const loaded = new ConversationStore(memento).get('mixed');
    expect(loaded?.messages[0].question).to.equal('  What does this do?  ');
    expect(loaded?.messages[1].localOnly).to.equal(true);
  });

  test('deleting one conversation never removes its siblings', async () => {
    const memento = new MemoryMemento();
    const store = new ConversationStore(memento);
    await store.save(conversation('keep-1', [userMessage('one')]));
    await store.save(conversation('keep-2', [userMessage('two')]));
    await store.save(conversation('drop', [userMessage('three')]));

    await store.delete('drop');
    expect(store.get('drop')).to.equal(undefined);
    expect(store.list().map((entry) => entry.id).sort()).to.deep.equal(['keep-1', 'keep-2']);
    expect(store.activeId()).to.not.equal('drop');
  });
});
