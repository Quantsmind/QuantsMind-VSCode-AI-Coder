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
      </div>
    </header>

    <div class="conversation-row">
      <select id="conversation-select" aria-label="Conversation history">
        <option value="">New chat</option>
      </select>
    </div>

    <button id="provider-status" class="status-pill" type="button" title="Provider settings">
      <span class="status-dot" id="status-dot"></span>
      <span class="status-text" id="status-text">Loading provider…</span>
    </button>
    <span class="version-badge" id="version" title="Installed QuantsMind AI Coder version">v0.0.0</span>

    <div class="workspace-row">
      <span class="workspace-name" id="workspace-name" title="Active workspace folder">No workspace</span>
      <button type="button" class="text-button" data-action="summarize-workspace" title="Summarize the workspace locally without sending anything">Summary</button>
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
