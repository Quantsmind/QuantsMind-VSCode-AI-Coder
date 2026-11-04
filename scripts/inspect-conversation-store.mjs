// Read-only evidence probe for GA Phase 7. Fingerprints the persisted conversation
// store so an upgrade can be proven not to lose records. Prints ids, counts, sizes,
// timestamps and hashes — never message text, titles or any secret value.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { extensionId } from './project-meta.mjs';

const STATE_KEY = 'quantsmind.quantsmind-vscode-ai-coder';
const CONVERSATIONS_KEY = 'quantsmind.chat.conversations.v1';
const ACTIVE_KEY = 'quantsmind.chat.activeConversation.v1';
const UNREADABLE_KEY = `${CONVERSATIONS_KEY}.unreadable.v1`;

// --user-data-dir is the directory VS Code itself was pointed at; the state DB
// always lives one level down, under User/globalStorage.
function defaultUserDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code');
  }
  return join(homedir(), '.config', 'Code');
}

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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readGlobalState(stateDb) {
  const db = new DatabaseSync(stateDb, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STATE_KEY);
    if (row === undefined) {
      throw new Error(`no ${STATE_KEY} row in ${stateDb} — wrong profile, or the extension never activated there`);
    }
    return typeof row.value === 'string' ? row.value : row.value.toString('utf8');
  } finally {
    db.close();
  }
}

function installedBuilds(extensionsDir) {
  if (!existsSync(extensionsDir)) {
    return ['<no such directory>'];
  }
  const prefix = `${extensionId}-`;
  return readdirSync(extensionsDir)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .sort();
}

function main() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        'Usage: node scripts/inspect-conversation-store.mjs [--user-data-dir <dir> | --state-db <file>] [--extensions-dir <dir>] [--label <text>]',
        '',
        'Reads a VS Code profile state DB with node:sqlite in readOnly mode and prints a',
        'content-free fingerprint of the QuantsMind conversation store: record ids, message',
        'and character counts, schema stamps, updatedAt order and hashes. Run it before and',
        'after an upgrade; the fingerprint line must match if no record was lost or rewritten.',
        '',
        'Close the VS Code window owning the profile first — a locked DB is reported, not forced.',
      ].join('\n'),
    );
    return;
  }

  const userDir = options['user-data-dir'] ? resolve(options['user-data-dir']) : undefined;
  const stateDb = options['state-db']
    ? resolve(options['state-db'])
    : join(userDir ?? defaultUserDataDir(), 'User', 'globalStorage', 'state.vscdb');
  const extensionsDir = options['extensions-dir']
    ? resolve(options['extensions-dir'])
    : join(homedir(), '.vscode', 'extensions');
  const label = options.label ?? 'inspect';

  if (!existsSync(stateDb)) {
    console.log(
      `[${label}] BLOCKED: no state DB at ${stateDb}. Pass --user-data-dir for a test profile, --state-db for the file directly, or omit both for the default install.`,
    );
    process.exitCode = 2;
    return;
  }
  const stats = statSync(stateDb);
  console.log(
    `[${label}] stateDb=${stateDb} sizeBytes=${stats.size} modified=${stats.mtime.toISOString()}`,
  );

  let rawValue;
  try {
    rawValue = readGlobalState(stateDb);
  } catch (error) {
    const message = String(error.message ?? error);
    if (/database is locked/i.test(message)) {
      console.log(`[${label}] BLOCKED: state DB is locked. Close the VS Code window that owns this profile and re-run.`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  console.log(
    `[${label}] rawValueChars=${rawValue.length} rawValueSha256=${sha256(rawValue).slice(0, 16)}`,
  );

  const globalState = JSON.parse(rawValue);
  const conversations = Array.isArray(globalState[CONVERSATIONS_KEY])
    ? globalState[CONVERSATIONS_KEY]
    : [];
  const unreadableSalvage = Array.isArray(globalState[UNREADABLE_KEY])
    ? globalState[UNREADABLE_KEY].length
    : 0;
  const activeId = globalState[ACTIVE_KEY];
  const parsable = conversations.filter(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      Array.isArray(entry.messages),
  );

  console.log(
    `[${label}] storedConversations=${conversations.length}` +
      ` parsable=${parsable.length}` +
      ` schemaV2=${parsable.filter((entry) => entry.schema === 2).length}` +
      ` salvagedUnreadableRows=${unreadableSalvage}` +
      ` activeConversationId=${typeof activeId === 'string' && activeId.length > 0 ? 'present' : 'absent'}`,
  );

  const orderedByTime = [...parsable].sort((a, b) =>
    String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')),
  );
  orderedByTime.forEach((entry, index) => {
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const textChars = messages.reduce(
      (sum, message) => sum + String(message?.text ?? '').length,
      0,
    );
    const withAttachmentContext = messages.filter(
      (message) => Array.isArray(message?.attachmentContext) && message.attachmentContext.length > 0,
    ).length;
    console.log(
      `  rank=${index}` +
        ` id=${entry.id}` +
        ` titleChars=${String(entry.title ?? '').length}` +
        ` schema=${entry.schema === undefined ? 'absent(legacy)' : entry.schema}` +
        ` messages=${messages.length}` +
        ` textChars=${textChars}` +
        ` attachmentContextTurns=${withAttachmentContext}` +
        ` createdAt=${entry.createdAt ?? 'unset'}` +
        ` updatedAt=${entry.updatedAt ?? 'unset'}`,
    );
  });

  const fingerprint = sha256(
    [...parsable]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((entry) => {
        const messages = Array.isArray(entry.messages) ? entry.messages : [];
        return [
          entry.id,
          entry.updatedAt ?? '',
          entry.createdAt ?? '',
          messages.length,
          messages.reduce((sum, message) => sum + String(message?.text ?? '').length, 0),
        ].join('|');
      })
      .join(';'),
  );
  console.log(
    `[${label}] recordFingerprint=${fingerprint} (compare this line before and after the upgrade)`,
  );

  console.log(
    `[${label}] installedBuildsUnder=${extensionsDir} versions=${installedBuilds(extensionsDir).join(',')}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${String(error.message ?? error)}`);
  process.exitCode = 1;
}
