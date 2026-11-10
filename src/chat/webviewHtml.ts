export interface WebviewAssets {
  readonly cspSource: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly nonce: string;
  readonly version: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const LOGO_SVG = `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
  <circle cx="11" cy="11" r="3" fill="none" stroke="currentColor" stroke-width="1.8"></circle>
  <path d="M16.5 16.5 L21 21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path>
  <circle cx="19.5" cy="4.5" r="1.7" fill="currentColor"></circle>
</svg>`;

export function renderChatHtml(assets: WebviewAssets): string {
  const nonce = escapeAttribute(assets.nonce);
  const csp = [
    "default-src 'none'",
    `style-src ${assets.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${assets.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}" />
  <link rel="stylesheet" href="${escapeAttribute(assets.styleUri)}" />
  <title>QuantsMind AI Coder</title>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        ${LOGO_SVG}
        <span class="brand-name">QuantsMind</span>
        <span class="alpha-badge">ALPHA</span>
      </div>
      <div class="topbar-actions">
        <button id="delete-conversation" class="icon-button" type="button" title="Delete this conversation" aria-label="Delete this conversation" hidden>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button id="new-chat" class="icon-button" type="button" title="New chat" aria-label="New chat">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>

        <button id="delete-conversation" class="icon-button" type="button" title="Delete this conversation" aria-label="Delete this conversation" hidden>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button id="new-chat" class="icon-button" type="button" title="New chat" aria-label="New chat">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
    </div>

    <!-- Topbar: Provider / Model selector -->
    <div class="provider-selector-row" id="provider-selector-row">
        <div class="selector-cell">
            <label for="provider-select">Provider: <span id="provider-name" class="provider-name">Loading…</span></label>
            <select id="provider-select" class="insight-select">
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="openai">OpenAI</option>
                <option value="groq">Groq</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (local)</option>
                <option value="lm-studio">LM Studio (local)</option>
                <option value="llama-cpp">llama.cpp (local)</option>
                <option value="vllm">vLLM (local)</option>
                <option value="gemini">Gemini</option>
                <option value="pollinations">Pollinations (no key)</option>
            </select>
            <button type="button" class="icon-button" title="Open provider settings" data-action="configure-provider">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm6 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm-4 4a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="currentColor"/></svg>
            </button>
        </div>
        <div class="selector-cell">
            <label for="model-select">Model: <span id="model-name" class="provider-name">Fetching…</span></label>
            <select id="model-select" class="insight-select"></select>
            <button type="button" class="icon-button" title="Refresh models" data-action="refresh-models">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm-.5 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm.5 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" fill="currentColor"/></svg>
            </button>
        </div>
        <div class="selector-cell">
            <button type="button" class="icon-button" title="Cancel running task" data-action="cancel" id="stop" hidden>
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
        </div>
    </div>
      </div>
    </header>

    <div class="conversation-row">
      <select id="conversation-select" aria-label="Conversation history">
        <option value="">New chat</option>
      </select>
    </div>
<main class="messages" id="messages" aria-live="polite" aria-label="Conversation">
      <div class="empty" id="empty">
        <div class="empty-logo">${LOGO_SVG}</div>
        <h1>Code, with evidence.</h1>
        <p>Ask a question or run an agent session that inspects the project, proposes a plan, executes approved tasks, validates with allowlisted commands, diagnoses failures, and reports only the evidence it collected.</p>
        <div class="quick-actions">
          <button type="button" class="quick-button" data-action="explain-selection">Explain selection</button>
          <button type="button" class="quick-button" data-action="attach-active">Attach active file</button>
          <button type="button" class="quick-button" data-action="summarize-workspace">Summarize workspace</button>
          <button type="button" class="quick-button" data-action="inspect-repository">Repository intelligence</button>
          <button type="button" class="quick-button accent" data-action="set-key" id="empty-set-key" hidden>Set API key</button>
        </div>
        <p class="empty-footnote">Plan, change-set and repair approvals are separate. Files are written only after per-file approval, validation commands run without a shell from your exact allowlist, and undo restores backups.</p>
<div class="empty" id="empty">
        <div class="empty-logo">${LOGO_SVG}</div>
        <h1>Code, with evidence.</h1>
        <p>Ask a question or run an agent session that inspects the project, proposes a plan, executes approved tasks, validates with allowlisted commands, diagnoses failures, and reports only the evidence it collected.</p>
        <div class="quick-actions">
          <button type="button" class="quick-button" data-action="explain-selection">Explain selection</button>
          <button type="button" class="quick-button" data-action="attach-active">Attach active file</button>
          <button type="button" class="quick-button" data-action="summarize-workspace">Summarize workspace</button>
          <button type="button" class="quick-button" data-action="inspect-repository">Repository intelligence</button>
          <button type="button" class="quick-button accent" data-action="set-key" id="empty-set-key" hidden>Set API key</button>
        </div>
        <p class="empty-footnote">Plan, change-set and repair approvals are separate. Files are written only after per-file approval, validation commands run without a shell from your exact allowlist, and undo restores backups.</p>
      </div>

      <!-- Task progress panel -->
      <div id="task-panel" class="task-panel" hidden>
        <div class="task-panel-header">
          <span id="task-status-label" class="task-status-label">Planning…</span>
          <span id="task-progress-bar" class="task-progress-bar"></span>
        </div>
        <div id="task-summary" class="task-summary"></div>
        <div class="subtask-list" id="subtask-list"></div>
      </div>

      <!-- Plan approval card -->
      <div id="plan-card" class="plan-card" hidden>
        <div class="plan-card-header">
          <span class="plan-icon">📋</span>
          <span class="plan-title">Implementation Plan Pending Approval</span>
        </div>
        <div class="plan-message" id="plan-message"></div>
        <div class="plan-tabs">
          <button class="plan-tab active" data-plan-tab="tasks">Tasks <span id="plan-task-count"></span></button>
          <button class="plan-tab" data-plan-tab="changes">Changes <span id="plan-change-count"></span></button>
        </div>
        <div class="plan-body">
          <div id="plan-tabs-tasks" class="plan-tab-pane active"></div>
          <div id="plan-tabs-changes" class="plan-tab-pane"></div>
        </div>
        <div class="plan-actions">
          <button id="approve-plan" class="primary-button">Approve Plan</button>
          <button id="reject-plan" class="secondary-button">Reject</button>
        </div>
      </div>
      </div>

      <!-- Task progress panel -->
      <div id="task-panel" class="task-panel" hidden>
        <div class="task-panel-header">
          <span id="task-status-label" class="task-status-label">Planning…</span>
          <span id="task-progress-bar" class="task-progress-bar"></span>
        </div>
        <div id="task-summary" class="task-summary"></div>
        <div class="subtask-list" id="subtask-list"></div>
      </div>

      <!-- Plan approval card -->
      <div id="plan-card" class="plan-card" hidden>
        <div class="plan-card-header">
          <span class="plan-icon">📋</span>
          <span class="plan-title">Implementation Plan Pending Approval</span>
        </div>
        <div class="plan-message" id="plan-message"></div>
        <div class="plan-tabs">
          <button class="plan-tab active" data-plan-tab="tasks">Tasks <span id="plan-task-count"></span></button>
          <button class="plan-tab" data-plan-tab="changes">Changes <span id="plan-change-count"></span></button>
        </div>
        <div class="plan-body">
          <div id="plan-tabs-tasks" class="plan-tab-pane active"></div>
          <div id="plan-tabs-changes" class="plan-tab-pane"></div>
        </div>
        <div class="plan-actions">
          <button id="approve-plan" class="primary-button">Approve Plan</button>
          <button id="reject-plan" class="secondary-button">Reject</button>
        </div>
      </div>

    <div class="history-row">
      <span class="history-status" id="history-status" title="Conversation history status">History: not loaded</span>
      <button type="button" class="text-button subtle" data-action="clear-conversation" id="clear-conversation" title="Clear this conversation only. Other conversations are kept." hidden>Clear</button>
      <button type="button" class="text-button subtle" data-action="restore-conversation" id="restore-conversation" title="Open the most recently updated stored conversation">Restore</button>
    </div>

    <div class="context-strip" id="context-strip" hidden></div>

    <!-- Topbar: Provider / Model + Stop -->
    <div class="provider-selector-row" id="provider-selector-row">
        <div class="selector-cell">
            <label for="provider-select">Provider: <span id="provider-name" class="provider-name">Loading…</span></label>
            <select id="provider-select" class="insight-select">
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="openai">OpenAI</option>
                <option value="groq">Groq</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (local)</option>
                <option value="lm-studio">LM Studio (local)</option>
                <option value="llama-cpp">llama.cpp (local)</option>
                <option value="vllm">vLLM (local)</option>
                <option value="gemini">Gemini</option>
                <option value="pollinations">Pollinations (no key)</option>
            </select>
            <button type="button" class="icon-button" title="Open provider settings" data-action="configure-provider">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm6 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm-4 4a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="currentColor"/></svg>
            </button>
        </div>
        <div class="selector-cell">
            <label for="model-select">Model: <span id="model-name" class="provider-name">Fetching…</span></label>
            <select id="model-select" class="insight-select"></select>
            <button type="button" class="icon-button" title="Refresh models" data-action="refresh-models">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm-.5 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm.5 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" fill="currentColor"/></svg>
            </button>
        </div>
        <div class="selector-cell">
            <button type="button" class="icon-button" title="Cancel running task" data-action="cancel" id="stop" hidden>
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
            </button>
        </div>
    </div>

    <div class="context-strip" id="context-strip" hidden></div>

    <button id="provider-status" class="status-pill" type="button" title="Provider settings">
      <span class="status-dot" id="status-dot"></span>
      <span class="status-text" id="status-text">Loading provider…</span>
    </button>
    <div class="provider-selector-row" id="provider-selector-row" hidden>
      <button type="button" class="text-button subtle" id="switch-provider" title="Switch provider">
        <span id="provider-name">–</span>
      </button>
      <span class="provider-separator">/</span>
      <button type="button" class="text-button subtle" id="switch-model" title="Switch model">
        <span id="model-name">–</span>
      </button>
      <span class="provider-class" id="provider-class">–</span>
      <button type="button" class="text-button subtle" id="set-api-key-selector" title="Set API key">Key</button>
    </div>
    <span class="version-badge" id="version" title="Installed QuantsMind AI Coder version">v0.0.0</span>

    <div class="workspace-row">
      <span class="workspace-name" id="workspace-name" title="Active workspace folder">No workspace</span>
      <button type="button" class="text-button" data-action="summarize-workspace" title="Summarize the workspace locally without sending anything">Summary</button>
      <button type="button" class="text-button" data-action="inspect-repository" title="Inspect repository structure and dependency relationships locally">Repository</button>
      <button type="button" class="text-button" data-action="inspect-git" title="Show local Git status: branch, changes, remotes, recent commits, and GitHub counts when connected">Git status</button>
      <button type="button" class="text-button" data-action="explain-context" title="Explain which files repository intelligence would select for the current prompt">Context why</button>
      <button type="button" class="text-button" data-action="attach-relevant" title="Attach files relevant to the current prompt">Relevant files</button>
    </div>

    <div class="session-row" id="session-row">
      <label class="session-label" for="session-select">Agent sessions</label>
      <select id="session-select" aria-label="Agent sessions">
        <option value="">No active session</option>
      </select>
      <button type="button" class="text-button" data-action="refresh-sessions" title="Refresh the session list from stored sessions">Refresh</button>
    </div>

    <main class="messages" id="messages" aria-live="polite" aria-label="Conversation">
      <div class="empty" id="empty">
        <div class="empty-logo">${LOGO_SVG}</div>
        <h1>Code, with evidence.</h1>
        <p>Ask a question or run an agent session that inspects the project, proposes a plan, executes approved tasks, validates with allowlisted commands, diagnoses failures, and reports only the evidence it collected.</p>
        <div class="quick-actions">
          <button type="button" class="quick-button" data-action="explain-selection">Explain selection</button>
          <button type="button" class="quick-button" data-action="attach-active">Attach active file</button>
          <button type="button" class="quick-button" data-action="summarize-workspace">Summarize workspace</button>
          <button type="button" class="quick-button" data-action="inspect-repository">Repository intelligence</button>
          <button type="button" class="quick-button accent" data-action="set-key" id="empty-set-key" hidden>Set API key</button>
        </div>
        <p class="empty-footnote">Plan, change-set and repair approvals are separate. Files are written only after per-file approval, validation commands run without a shell from your exact allowlist, and undo restores backups.</p>
      </div>
    </main>

    <section class="composer" aria-label="Compose a request">
      <div class="attachment-bar" id="attachment-bar" hidden></div>
      <div class="attach-actions">
        <button type="button" class="text-button" data-action="attach-selection">Selection</button>
        <button type="button" class="text-button" data-action="attach-active">Active file</button>
        <button type="button" class="text-button" data-action="attach-files">Files…</button>
        <button type="button" class="text-button" data-action="attach-relevant">Relevant files</button>
        <button type="button" class="text-button subtle" data-action="clear-attachments" id="clear-attachments" hidden>Clear</button>
        <span class="context-budget" id="context-budget"></span>
      </div>
      <div class="mode-row">
        <label for="mode">Mode</label>
        <select id="mode" aria-label="Request mode">
          <option value="ask">Ask</option>
          <option value="explain">Explain</option>
          <option value="generate">Generate</option>
          <option value="agent">Agent session (plan → execute)</option>
        </select>
        <button type="button" class="text-button subtle" data-action="show-log" title="Open the QuantsMind output log">Log</button>
      </div>
      <div class="input-shell">
        <textarea id="prompt" rows="3" maxlength="20000" placeholder="Ask about your code. Nothing is sent until you press Send." aria-label="Question for QuantsMind"></textarea>
        <div class="composer-actions">
          <button type="button" id="stop" class="stop-button" hidden>Stop</button>
          <button type="button" id="send" class="send-button">Send <span class="key-hint">↵</span></button>
        </div>
      </div>
      <p class="privacy-note" id="privacy-note">Only attached content is sent. Ask/Explain/Generate never modify files; Agent mode requires per-file approval before applying and can be undone.</p>
    </section>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

  <script nonce="${nonce}" src="${escapeAttribute(assets.scriptUri)}"></script>
</body>
</html>`;
}
