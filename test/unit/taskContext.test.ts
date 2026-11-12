import { expect } from 'chai';
import { TaskContextStore, contextTools, MAX_ENTRIES_PER_TASK, MAX_VALUE_LENGTH } from '../../src/agent/context';

suite('task context store', () => {
  test('sets, gets, lists and snapshots entries per task', () => {
    const store = new TaskContextStore();

    expect(store.set('a', 'decision', 'use PostgreSQL').ok).to.equal(true);
    expect(store.set('a', 'files.changed', 'src/db.ts').ok).to.equal(true);
    expect(store.set('b', 'decision', 'use Redis').ok).to.equal(true);

    expect(store.get('a', 'decision')).to.equal('use PostgreSQL');
    expect(store.get('b', 'decision')).to.equal('use Redis');
    expect(store.list('a').map((entry) => entry.key)).to.deep.equal(['decision', 'files.changed']);
    expect(store.snapshot('a')).to.deep.equal({ decision: 'use PostgreSQL', 'files.changed': 'src/db.ts' });

    store.clear('a');
    expect(store.get('a', 'decision')).to.equal(undefined);
    expect(store.get('b', 'decision')).to.equal('use Redis');
  });

  test('rejects invalid keys and oversized values', () => {
    const store = new TaskContextStore();

    expect(store.set('t', 'has space', 'x').ok).to.equal(false);
    expect(store.set('t', '', 'x').ok).to.equal(false);
    expect(store.set('t', 'a'.repeat(65), 'x').ok).to.equal(false);
    expect(store.set('t', 'ok', 'y'.repeat(MAX_VALUE_LENGTH + 1)).ok).to.equal(false);
    expect(store.set('', 'key', 'value').ok).to.equal(false);
  });

  test('enforces per-task and store-wide entry caps', () => {
    const store = new TaskContextStore();

    for (let index = 0; index < MAX_ENTRIES_PER_TASK; index += 1) {
      expect(store.set('a', `k${index}`, 'v').ok).to.equal(true);
    }
    expect(store.set('a', 'one-more', 'v').ok).to.equal(false);
  });

  test('agent tools roundtrip through the store', async () => {
    const store = new TaskContextStore();
    const tools = new Map(contextTools(store).map((tool) => [tool.name, tool]));

    const set = await tools.get('context_set')!.execute({ key: 'note', value: 'shared', taskId: 't1' });
    expect(set.ok).to.equal(true);

    const get = await tools.get('context_get')!.execute({ key: 'note', taskId: 't1' });
    expect(get.ok).to.equal(true);
    expect(get.output).to.contain('shared');

    const list = await tools.get('context_list')!.execute({ taskId: 't1' });
    expect(list.ok).to.equal(true);
    expect(list.output).to.contain('note');

    const missing = await tools.get('context_get')!.execute({ key: 'nope', taskId: 't1' });
    expect(missing.ok).to.equal(false);
  });
});
