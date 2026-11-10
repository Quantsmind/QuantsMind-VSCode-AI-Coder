// Creates a throwaway VS Code profile whose persisted conversation store is
// deliberately partly unreadable, so GA Phase 7 can exercise the on-disk salvage
// and upgrade paths against real storage instead of an in-memory fixture.
//
// It refuses to write anywhere that already holds a state DB, so it cannot be
// pointed at a real profile by mistake. Transcript text is invented; the one
// captured attachment is the repository's own test-fixture file, so the
// attachment freshness audit has a real checksum to compare against.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectRoot } from './project-meta.mjs';

const STATE_KEY = 'quantsmind.quantsmind-vscode-ai-coder';
const CONVERSATIONS_KEY = 'quantsmind.chat.conversations.v1';
const ACTIVE_KEY = 'quantsmind.chat.activeConversation.v1';
const MARKER_FILE = 'quantsmind-fixture.json';
const CAPTURED_ATTACHMENT = 'test/fixtures/workspace/src/utils.ts';

function args(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) {
      throw new Error(`unexpected argument ${flag}`);
    }
    const name = flag.slice(2);
    if (name === 'help') {
      parsed.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} needs a value`);
    }
    parsed[name] = value;
    i += 1;
  }
  return parsed;
}

function message(role, text, createdAt, extra = {}) {
  return { role, text, attachments: [], createdAt, ...extra };
}

function capturedAttachment(capturedAt) {
  const content = readFileSync(join(projectRoot, CAPTURED_ATTACHMENT), 'utf8');
  return {
    path: 'src/utils.ts',
    content,
    chars: content.length,
    checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
    languageId: 'typescript',
    isSelection: false,
    redactions: 0,
    capturedAt,
  };
}

function fixtureConversations() {
  const older = '2026-10-01T09:00:00.000Z';
  const newer = '2026-10-20T14:30:00.000Z';
  return [
    {
      id: 'fixture-legacy-v1',
      title: 'Legacy v1 record',
      createdAt: older,
      updatedAt: newer,
      messages: [
        message('user', 'Fixture legacy turn one', older, { attachments: ['src/example.ts'] }),
        message('assistant', 'Fixture legacy answer, no captured context.', older),
      ],
    },
    {
      id: 'fixture-current-v2',
      title: 'Current v2 record',
      createdAt: newer,
      updatedAt: '2026-10-22T08:15:00.000Z',
      schema: 2,
      messages: [
        message('user', 'Fixture v2 question', newer, {
          question: 'Fixture question text sent to the provider',
          attachmentContext: [capturedAttachment(newer)],
        }),
        message('assistant', 'Fixture v2 answer.', newer, { localOnly: false }),
        message('assistant', 'Fixture local-only summary, never sent.', newer, { localOnly: true }),
      ],
    },
    'fixture-corrupted-string-record',
    { id: 'fixture-corrupted-missing-messages', title: 'x', createdAt: newer, updatedAt: newer },
  ];
}

function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        'Usage: node scripts/seed-test-profile.mjs --profile <new-directory>',
        '',
        'Creates <new-directory>/User/globalStorage/state.vscdb holding a QuantsMind',
        'conversation store with two readable records (one legacy v1, one v2 with captured',
        'attachment context) and two deliberately unreadable ones, then prints the launch,',
        'probe and cleanup commands for the GA Phase 7 salvage and upgrade evidence.',
        '',
        'Refuses to run if the directory already contains a state DB. Never point it at a',
        'real VS Code user data directory.',
      ].join('\n'),
    );
    return;
  }

  const profile = resolve(options.profile ?? '');
  if (!options.profile) {
    throw new Error('--profile is required');
  }
  const stateDb = join(profile, 'User', 'globalStorage', 'state.vscdb');
  if (existsSync(stateDb)) {
    throw new Error(
      `refusing to write: ${stateDb} already exists. Choose a fresh directory — this script is for a throwaway test profile only.`,
    );
  }

  mkdirSync(join(profile, 'User', 'globalStorage'), { recursive: true });
  const db = new DatabaseSync(stateDb);
  let valueChars;
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
    );
    const payload = {
      [CONVERSATIONS_KEY]: fixtureConversations(),
      [ACTIVE_KEY]: 'fixture-current-v2',
    };
    const raw = JSON.stringify(payload);
    valueChars = raw.length;
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(STATE_KEY, raw);
  } finally {
    db.close();
  }

  const marker = {
    quantsMindFixture: true,
    createdFromRepo: 'scripts/seed-test-profile.mjs',
    profile,
    stateDb,
    runId: randomUUID(),
    recordCount: fixtureConversations().length,
    unreadableRecordCount: 2,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(profile, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  console.log(`Created throwaway test profile: ${profile}`);
  console.log(
    `  stateDb=${stateDb} sizeBytes=${statSync(stateDb).size} rawValueChars=${valueChars}`,
  );
  console.log(`  marker=${join(profile, MARKER_FILE)} runId=${marker.runId}`);
  console.log('');
  const probe = `node scripts/inspect-conversation-store.mjs --user-data-dir "${profile}" --extensions-dir "${join(profile, 'extensions')}"`;
  console.log('Next steps (<code> is your VS Code launcher, <vsix> the release candidate):');
  console.log(`  ${probe} --label before`);
  console.log(
    `  <code> --user-data-dir "${profile}" --extensions-dir "${join(profile, 'extensions')}" --logsPath "${join(profile, 'logs')}" --install-extension <vsix>`,
  );
  console.log(
    `  <code> --user-data-dir "${profile}" --extensions-dir "${join(profile, 'extensions')}" --logsPath "${join(profile, 'logs')}" "${join(projectRoot, 'test', 'fixtures', 'workspace')}"`,
  );
  console.log('  then: open the QuantsMind chat panel, Restore the previous conversation, and read');
  console.log(`        ${join(profile, 'logs')} for the salvage, history and attachment-freshness lines.`);
  console.log(`  node scripts/inspect-conversation-store.mjs --user-data-dir "${profile}" --label after`);
  console.log('  the recordFingerprint must be identical for before/after, and the unreadable rows');
  console.log('  must now appear under salvagedUnreadableRows rather than having vanished.');
  console.log('');
  console.log(`Remove ${profile} by hand when the evidence is recorded; this script never deletes.`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${String(error.message ?? error)}`);
  process.exitCode = 1;
}
