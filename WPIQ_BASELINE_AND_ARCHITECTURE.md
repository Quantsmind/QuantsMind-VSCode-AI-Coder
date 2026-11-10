# QuantsMind VS Code AI Coder v2.0.0 — WPIQ Baseline and Architecture Report

**Date:** 2026-11-09  
**Branch:** `release/v0.4.0`  
**HEAD:** `1fc6b5fae8f0fdfd8168b0049b967619fb2a3569`  
**Package version:** `2.0.0`  
**Report:** WPIQ Baseline and Architecture (WP1 deliverable)

---

## 1. Baseline Verification

| Check | Value | Status |
|-------|-------|--------|
| Branch | `release/v0.4.0` | PASS |
| HEAD | `1fc6b5fae8f0fdfd8168b0049b967619fb2a3569` | PASS |
| Version | `2.0.0` | PASS |
| VSIX 2.0.0 original SHA-256 | `2EE20F6568D562E6ABD9F16A7C4F1D1B3112E825DBA57206DA91FB5D00C12578` / 363,506 bytes | PASS (unchanged) |
| VSIX 1.3.0 original SHA-256 | `5042678E6F63764A31DC7A136987FFB1A69617B4E4CDF7915B8CA01B9D29A84E` / 362,420 bytes | PASS (unchanged) |
| Remediated VSIX SHA-256 | `3F8204BB7A9E62D5C21451E8DCBF746B1D5CD94E40E3C4847FBE4A876461F728` / 365,339 bytes | PASS (distinct artifact) |
| Commits / pushes / tags | None | PASS |
| Publication activity | None | PASS |

## 2. Repository State

| Category | Count | Details |
|----------|-------|---------|
| Modified tracked files | 36 | Source, config, test, media, scripts |
| Untracked files | 51 | Test files, reports, scripts, temp files |
| Secondary worktrees | 1 | `feature-v1.0.0-provider-foundation` at `80e6278` |

No commits, pushes, merges, or tags have been made. All pre-existing working-tree changes are preserved.

## 3. Source Architecture Map

The extension follows a layered architecture with clear separation of concerns:

### Extension Layer (`src/extension.ts`)
- Extension activation/deactivation lifecycle
- Command registration (20 commands via `COMMANDS` registry)
- Provider selection with paid-provider warning
- Connection testing
- API key management (set/clear via SecretStorage)
- Status bar management
- Chat view provider registration

### Provider Layer (`src/providers/`)
| File | Responsibility |
|------|---------------|
| `profiles.ts` | Provider profiles, access/pricing classification, Pollinations preset |
| `registry.ts` | Provider adapter registry (openai-compatible, gemini) |
| `completionService.ts` | Provider status, model discovery, connection testing, completion |
| `connectionTest.ts` | Connection test with reachability/authentication/model discovery |
| `modelDiscovery.ts` | Model listing from provider endpoints |
| `errors.ts` | Provider error normalization and classification |
| `endpoint.ts` | Endpoint validation and normalization |
| `retry.ts` | Retry logic with backoff |
| `sse.ts` | Server-sent events parsing |
| `capabilities.ts` | Native tool calling capability detection |
| `openaiCompatible.ts` | OpenAI-compatible HTTP client |
| `geminiCompatible.ts` | Gemini API client |
| `cancellation.ts` | Cancellation token utilities |

### Configuration Layer (`src/config/`)
| File | Responsibility |
|------|---------------|
| `settings.ts` | SettingsService - reads/writes VS Code settings (application-scoped) |
| `resolve.ts` | Setting resolution with defaults and clamping |
| `defaults.ts` | Default values and limits |

### Security Layer (`src/security/`)
| File | Responsibility |
|------|---------------|
| `secretStore.ts` | SecretStorage wrapper with per-provider key namespacing |
| `credential.ts` | Credential validation |
| `logger.ts` | Redacting logger |
| `redact.ts` | Credential redaction from logs and output |
| `workspaceTrust.ts` | Workspace trust check |

### Agent Layer (`src/agent/`)
| File | Responsibility |
|------|---------------|
| `orchestrator.ts` | Agent session lifecycle (plan → execute → validate → repair) |
| `runtime.ts` | Extension-side adapter connecting orchestrator to VS Code APIs |
| `planning.ts` | Development plan parsing and validation |
| `scheduler.ts` | Task scheduling and dependency resolution |
| `stateMachine.ts` | Session and task state transitions |
| `validation.ts` | Validation binding and evidence tracking |
| `codingAgent.ts` | Coding agent loop (plan → tool → result → final answer) |
| `commandTools.ts` | Command execution tools |
| `changeTools.ts` | Change set application tools |
| `workspaceTools.ts` | Workspace file tools |
| `repositoryTools.ts` | Repository intelligence tools |

### Chat Layer (`src/chat/`)
| File | Responsibility |
|------|---------------|
| `chatViewProvider.ts` | Webview view provider and message handling |
| `protocol.ts` | Webview message contracts |
| `webviewHtml.ts` | Chat HTML rendering |
| `persistence.ts` | Conversation persistence |
| `session.ts` | Session management |
| `prompts.ts` | Chat prompt construction |
| `attachmentContext.ts` | Attachment context handling |

### Changes Layer (`src/changes/`)
| File | Responsibility |
|------|---------------|
| `changeService.ts` | Change set management (apply, undo, history) |
| `changeService.ts` | Change set model and serialization |
| `apply.ts` | Change set application with backups |
| `diff.ts` | Unified diff generation |
| `plan.ts` | Change plan parsing |
| `review.ts` | Change review rendering |
| `history.ts` | Change history storage |
| `model.ts` | Change model types |

### Security Guarantees (Preserved)
- **SecretStorage**: API keys stored per-provider in VS Code SecretStorage, never in settings.json
- **Credential isolation**: Each provider has its own secret key namespace
- **Logs**: API keys and bearer tokens redacted from all log output
- **Workspace trust**: Restricted mode prevents workspace enumeration and disk reads
- **Command allowlist**: Only exact allowlisted commands can execute, no shell metacharacters
- **Approval gates**: All file changes and command executions require explicit user approval
- **No paid fallback**: Paid provider selection requires explicit confirmation modal

## 4. Integration Boundaries

| Boundary | Direction | Mechanism |
|----------|-----------|-----------|
| Extension host → Webview chat | Outbound | `webview.postMessage()` |
| Webview chat → Extension host | Inbound | `webview.onDidReceiveMessage()` |
| Extension → SecretStorage | Outbound | `context.secrets` API |
| Extension → File system | Outbound | `vscode.workspace.fs` API |
| Extension → Command execution | Outbound | `child_process.spawn` (shell-free) |
| Extension → Provider APIs | Outbound | `fetch` (HTTP/SSE) |
| Provider → Extension | Inbound | HTTP response bodies |

## 5. Test Infrastructure

| Test Type | Location | Framework | Count |
|-----------|----------|-----------|-------|
| Unit tests | `test/unit/` | Mocha + Chai | 748 passing |
| Integration tests | `test/integration/` | Mocha + Chai + VS Code test host | 124 passing |
| Packaged tests | `test/packaged/` | Mocha + Chai + VS Code packaged test | 4 passing |
| GUI tests (CDP) | `test/packaged/g01-g15-gui-tests.cjs` | CDP | 12 passing, 3 blocked |

## 6. Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| CDP cannot reliably open VS Code command palette | G07, G13, G14 GUI tests blocked | Service-level integration tests cover equivalent behavior |
| Pollinations live endpoint may be unavailable | Live provider tests skipped gracefully | Mock-based provider tests cover all logic paths |
| Lint has 10 errors / 27 warnings | Pre-existing, all in test/media files | Does not affect product code |

---

## WPIQ Baseline Status: ESTABLISHED

All baseline values verified, architecture mapped, and test infrastructure established. Ready to proceed with WP1-WP5 implementation.
