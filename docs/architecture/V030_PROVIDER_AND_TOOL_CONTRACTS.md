# v0.3.0 Provider and Tool Contracts

This document defines the provider-neutral contract, the structured response
schemas the controller consumes, and the tool routing contract. It describes
what is implemented in `src/providers`, `src/agent/planning.ts`,
`src/changes/plan.ts`, and `src/agent/toolRouter.ts`.

## 1. Provider contract

```ts
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stream: boolean;
}

export interface CompletionResult {
  readonly text: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly usage?: CompletionUsage;
}

export interface AiProvider {
  readonly id: string;
  readonly displayName: string;
  complete(
    request: CompletionRequest,
    options?: CompletionOptions,
  ): Promise<CompletionResult>;
}

export type IProvider = AiProvider;
```

`CompletionOptions` carries a cancellation token, a timeout in milliseconds and
an optional delta callback. A provider must:

1. Reject with a normalized `ProviderError` (`code`, `message`, `retryable`).
2. Never include authorization headers, API keys or raw response bodies in an
   error message.
3. Stop the HTTP request when the token is cancelled or the timeout elapses.
4. Return the final text in `CompletionResult.text`; streaming deltas are
   advisory UI events and are not used as source data.
5. Not execute tools, not write files and not run commands.

The v0.3.0 provider is OpenAI-compatible (`src/providers/openaiCompatible.ts`).
It posts to `<baseUrl>/chat/completions` with `model`, `messages`, optional
`temperature`/`max_tokens`, and `stream`. The v0.2.0 behavior, URL validation,
HTTPS policy, SSE parsing and error normalization are preserved.

## 2. Provider capabilities

```ts
export interface ProviderCapabilities {
  readonly nativeToolCalling: boolean;  // false in v0.3.0
  readonly structuredOutput: boolean;   // true: validated JSON text
  readonly streaming: boolean;          // from settings
  readonly maxContextChars: number;     // advisory request budget
}

export function describeCapabilities(
  settings: ResolvedProviderSettings,
): ProviderCapabilities;
```

The controller does not branch on provider name. It reads capabilities:

- `structuredOutput` must be `true` for planning and implementation. It is true
  for every provider because structured output here means "the prompt requests
  JSON and the parser validates it", not a vendor-specific JSON mode.
- `nativeToolCalling` is `false`. No provider may receive executable tool
  definitions in v0.3.0.
- `streaming` affects only incremental display; it never changes parsing.
- `maxContextChars` is advisory. Retrieval budgeting currently uses
  `quantsmind.workspace.retrievalMaxChars` clamped by
  `quantsmind.context.maxTotalChars`; the capability value is exposed for
  future provider-specific trimming.

## 3. Request assembly

Every provider request is built by a pure function. The system prompt:

- states the role and the exact JSON schema,
- marks workspace and command output as untrusted reference data,
- forbids claims that files were written or commands were run,
- forbids credentials in output,
- requires complete file contents and workspace-relative paths.

User content order:

```text
Project context summary (local facts)
Relevant workspace content (<workspace_context> ... </workspace_context>)
Task/requirement
Repair evidence, when applicable
"Return the JSON object now."
```

Budget rules (applied before the request):

- project summary: 6,000 characters,
- retrieved file content: `quantsmind.workspace.retrievalMaxChars`,
- repair command output: 6,000 characters (redacted, truncated),
- diagnostics: 20 entries,
- total request: bounded by the context settings; overflow drops the
  lowest-ranked file first and records `truncated`.

## 4. Structured response: development plan

Prompt contract (`buildDevelopmentPlanMessages`):

```json
{
  "summary": "one short paragraph",
  "approach": "how the tasks achieve the requirement",
  "risks": ["optional risk"],
  "tasks": [
    {
      "id": "task-1",
      "title": "short imperative title",
      "description": "what to implement and why",
      "dependsOn": ["task-0"],
      "suggestedFiles": ["src/example.ts"],
      "validationCommand": "npm run test:unit",
      "criteria": [
        { "text": "the new behavior is covered by a test", "verification": "command" }
      ]
    }
  ]
}
```

Parser contract (`parseDevelopmentPlan(text, options)`):

| Rule | Failure mode |
| --- | --- |
| Response must contain one JSON object (fenced or bare) | Fail with `The provider response did not contain a JSON plan.` |
| `tasks` must be an array | Fail |
| 0 tasks is allowed | Valid |
| Maximum 20 tasks | Fail |
| Task ids unique, `[A-Za-z0-9._-]{1,64}` | Fail |
| Missing id assigned `task-N` deterministically | Accepted |
| Dependencies reference existing tasks, no self-dependency | Fail |
| Dependency graph acyclic | Fail |
| Unknown fields ignored | Accepted |
| `validationCommand` must be an exact allowlist entry and metacharacter-free | Dropped with a warning, not executed |
| Criteria strings or `{text, verification}` | Normalized; unknown verification becomes `manual` |
| Strings truncated to documented maxima | Accepted with truncation |

The parser never touches the disk. The orchestrator inspects the plan content
only after preparation, never during parsing.

## 5. Structured response: change set

The implementation request reuses the v0.2.0 change-plan schema and parser:

```json
{
  "summary": "intended outcome",
  "notes": "optional assumptions",
  "changes": [
    { "kind": "create", "path": "src/a.ts", "summary": "why", "content": "complete file" },
    { "kind": "modify", "path": "src/b.ts", "summary": "why", "content": "complete file" },
    { "kind": "delete", "path": "src/old.ts", "summary": "why" },
    { "kind": "rename", "fromPath": "src/x.ts", "path": "src/y.ts", "summary": "why" }
  ]
}
```

Parsing rules (unchanged from v0.2.0):

- complete contents for create/modify, never patches or placeholders,
- safe workspace-relative path,
- unique target paths; rename sources unique,
- maximum 20 files and the content limits,
- malformed entries fail the whole plan,
- an empty `changes` array is a valid "no change required" response and is
  handled by the orchestrator as a completed analysis task, not a file write.

## 6. Structured response: repair

Repair uses the same change-set schema. The user message adds:

```text
A previous change was applied, but validation failed.
Task: <title and description>
Validation command: <exact command>
Exit code: <number|null>
Timed out: <true|false>
Diagnostics:
- [source/severity] message (file:line)
Validation output (redacted, truncated):
<up to 6000 chars>

Produce a complete replacement change set that fixes the failure.
Do not weaken tests, remove assertions, disable lint rules or change the
validation command.
```

The parser is identical. The orchestrator rejects an empty repair plan, because
an empty repair cannot be evidence of a fix.

## 7. Failure behavior

| Condition | Behavior |
| --- | --- |
| Empty response | `failed`: "The provider returned an empty response." |
| No JSON | `failed`: "The provider response did not contain a JSON plan." |
| Invalid JSON | `failed`: "The provider response contained invalid JSON." |
| Wrong top-level type / missing array | `failed` with the schema error |
| Unsafe path or oversized content | `failed` with the specific validation error |
| Timeout | Normalized provider error; state `failed`, task not applied |
| Cancellation | State `cancelled`; no side effect after the await |
| Step budget exceeded | `failed` before the request is sent |
| HTTP 4xx/5xx | Normalized provider error; raw body not shown |

Parse failures never fall back to a heuristic plan. The session stays failed
until the user starts a new session with a narrower request.

## 8. Tool contracts

v0.3.0 keeps tools local. The model receives no tool definitions and no
function-calling channel. The contracts exist so a future native-tool adapter
has a single, auditable entry point:

```ts
export type ToolKind =
  | 'read-file'
  | 'list-files'
  | 'apply-change-set'
  | 'run-command'
  | 'collect-diagnostics';

export interface ToolRequest {
  readonly id: string;
  readonly kind: ToolKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
}

export interface ToolExecutionResult {
  readonly requestId: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly output?: string;
  readonly durationMs: number;
}

export interface IToolRouter {
  route(request: ToolRequest): Promise<ToolExecutionResult>;
}
```

Router rules:

1. A request without a registered handler returns `ok: false` with
   "No handler is registered for <kind>." It never guesses.
2. `apply-change-set` requires a prepared plan and an approval decision; the
   orchestrator does not register this handler for model-originated requests.
3. `run-command` requires an `CommandPolicy.allowed === true` decision and an
   approved exact command; the orchestrator does not register it for
   model-originated requests.
4. Handlers receive parsed payloads, not raw model text.
5. Every result is logged with a redacted detail and a duration; failures do not
   throw through the router.
6. The router cannot be reached from the webview.

The interface table in `V030_SYSTEM_ARCHITECTURE.md` maps `IToolRouter` to this
module. It is implemented, but deliberately unused for write/execute actions in
v0.3.0.

## 9. Command policy contract

```ts
export interface CommandPolicy {
  readonly allowed: boolean;
  readonly risk: 'validation' | 'read-only' | 'destructive' | 'unknown';
  readonly requiresApproval: boolean;
  readonly normalized?: string;
  readonly reason: string;
}

export function evaluateCommand(
  raw: string,
  allowlist: readonly string[],
): CommandPolicy;
```

Evaluation order:

1. Type, trim, normalization and control-character checks.
2. Shell metacharacter rejection.
3. Exact allowlist membership (case-sensitive, whitespace-normalized).
4. Tokenization with the shared parser; executable must be a bare name.
5. Risk classification by known validation/read-only/destructive verbs.
6. Destructive commands are denied even if listed.
7. Every allowed command `requiresApproval: true`; approval is per execution.

The policy never shells out and never interpolates. `runApprovedCommand`
re-validates independently, so bypassing the policy cannot bypass the runner.

## 10. Compatibility and versioning

- The provider adapter request/response format is stable within v0.3.0.
- Adding a field to a response schema is backward compatible only if the parser
  ignores unknown fields (it does).
- Removing or renaming a schema field requires a new prompt version and tests.
- The session schema is versioned separately (`SESSION_SCHEMA_VERSION = 1`);
  provider changes never mutate persisted sessions.
- The User-Agent reports the extension version so providers can distinguish
  releases. It contains no credentials or machine identifiers.
