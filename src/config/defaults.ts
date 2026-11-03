export const CONFIG_SECTION = 'quantsmind';

export const DEFAULT_PROVIDER_TYPE = 'openai-compatible';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_STREAM = true;
export const DEFAULT_ALLOW_INSECURE_LOCALHOST = true;

export const DEFAULT_MAX_FILE_SIZE_KB = 256;
export const DEFAULT_MAX_TOTAL_CHARS = 48_000;
export const DEFAULT_MAX_FILES = 20;
export const DEFAULT_HISTORY_CHARS = 24_000;

export const DEFAULT_WORKSPACE_MAX_INDEXED_FILES = 5_000;
export const DEFAULT_WORKSPACE_MAX_RETRIEVED_FILES = 8;
export const DEFAULT_WORKSPACE_RETRIEVAL_MAX_CHARS = 40_000;

export const DEFAULT_AGENT_MAX_STEPS = 6;
export const DEFAULT_AGENT_MAX_REPAIR_ITERATIONS = 1;
export const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 120_000;
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = Object.freeze([
  'npm run compile',
  'npm run lint',
  'npm test',
  'npm run test:unit',
]);

export const MAX_CONVERSATIONS = 30;
export const MAX_CONVERSATION_CHARS = 120_000;
export const CONVERSATION_STORAGE_KEY = 'quantsmind.chat.conversations.v1';
export const CHANGE_HISTORY_KEY = 'quantsmind.changes.history.v1';
export const MAX_CHANGE_HISTORY = 50;

/**
 * These exclusions are mandatory. User settings can add patterns but cannot
 * remove the built-in secret, dependency, and build-output protections.
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.kdbx',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'credentials.json',
  'secrets.json',
  '**/.git/**',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/node_modules/**',
  '**/bower_components/**',
  '**/dist/**',
  '**/out/**',
  '**/coverage/**',
  '**/.vscode-test/**',
  '**/secrets/**',
  '**/*.secret',
  '**/*secret*.json',
  '**/*credential*.json',
]);

export const LIMITS = Object.freeze({
  timeoutMs: { min: 5_000, max: 600_000 },
  maxOutputTokens: { min: 16, max: 131_072 },
  temperature: { min: 0, max: 2 },
  maxFileSizeKb: { min: 1, max: 2_048 },
  maxTotalChars: { min: 2_000, max: 400_000 },
  maxFiles: { min: 1, max: 100 },
  maxExcludePatterns: 100,
  maxPromptChars: 20_000,
  maxIndexedFiles: { min: 100, max: 20_000 },
  maxRetrievedFiles: { min: 1, max: 50 },
  retrievalMaxChars: { min: 2_000, max: 200_000 },
  agentMaxSteps: { min: 1, max: 20 },
  agentMaxRepairIterations: { min: 0, max: 5 },
  agentTimeoutMs: { min: 10_000, max: 900_000 },
  commandTimeoutMs: { min: 1_000, max: 600_000 },
  commandOutputMaxChars: { min: 1_000, max: 1_000_000 },
  maxCommandAllowlist: 20,
});
