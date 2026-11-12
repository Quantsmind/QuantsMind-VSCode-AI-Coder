import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderChatHtml } from '../../src/chat/webviewHtml';

const NONCE = 'abc123nonce';

function script(): string {
  return readFileSync(join(__dirname, '..', '..', '..', 'media', 'chat.js'), 'utf8');
}

function render(): string {
  return renderChatHtml({
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/media/chat.js',
    styleUri: 'https://file+.vscode-resource.vscode-cdn.net/media/chat.css',
    nonce: NONCE,
    version: '0.2.0',
  });
}

suite('webview HTML', () => {
  test('uses a restrictive content security policy with a nonce', () => {
    const html = render();
    expect(html).to.contain("default-src 'none'");
    expect(html).to.contain(`script-src 'nonce-${NONCE}'`);
    expect(html).to.contain('style-src https://file+.vscode-resource.vscode-cdn.net');
    expect(html).to.contain('img-src https://file+.vscode-resource.vscode-cdn.net data:');
    expect(html).to.not.contain("'unsafe-inline'");
    expect(html).to.not.contain("'unsafe-eval'");
  });

  test('loads only local scripts and styles with the nonce', () => {
    const html = render();
    expect(html).to.contain(`<script nonce="${NONCE}" src=`);
    expect(html).to.contain('media/chat.js');
    expect(html).to.contain('media/chat.css');
  });

  test('does not include inline executable scripts or remote resources', () => {
    const html = render();
    expect(html).to.not.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    expect(html).to.not.match(/https?:\/\/(?!file\+\.vscode-resource\.vscode-cdn\.net)/);
  });

  test('states the explicit-send and approval-first guarantees', () => {
    const html = render();
    expect(html).to.contain('Nothing is sent until you press Send');
    expect(html).to.contain('Files are written only after per-file approval');
    expect(html).to.contain('undo restores backups');
    expect(html).to.contain('Agent session (plan → execute)');
  });

  test('renders conversation history and workspace controls', () => {
    const html = render();
    expect(html).to.contain('id="conversation-select"');
    expect(html).to.contain('id="delete-conversation"');
    expect(html).to.contain('data-action="summarize-workspace"');
    expect(html).to.contain('data-action="inspect-repository"');
    expect(html).to.contain('data-action="explain-context"');
    expect(html).to.contain('data-action="attach-relevant"');
  });

  test('shows history status, request context and conversation-management controls', () => {
    const html = render();
    expect(html).to.contain('id="history-status"');
    expect(html).to.contain('id="context-strip"');
    expect(html).to.contain('id="clear-conversation"');
    expect(html).to.contain('data-action="clear-conversation"');
    expect(html).to.contain('data-action="restore-conversation"');
    expect(html).to.contain('id="new-chat"');
  });

  test('renders the v3.1.0 chat affordances: continuation, copy controls, resize and jump-latest', () => {
    const html = render();
    expect(html).to.contain('id="jump-latest"');
    expect(html).to.contain('id="composer-resize"');
    expect(html).to.contain('aria-valuemin="58"');
    expect(html).to.contain('aria-valuemax="320"');
    expect(html).to.contain('aria-valuenow="58"');
    expect(html).to.contain('data-action="copy-log"');
    expect(html).to.contain('data-action="refresh-sessions"');
    expect(html).to.contain('class="icon-refresh');
    expect(html).to.contain('id="refresh-sessions"');

    const source = script();
    expect(source).to.contain("'continue-assistant'");
    expect(source).to.contain('case \'continue-assistant\'');
    expect(source).to.contain('case \'copy-response\'');
    expect(source).to.contain('case \'copy-log\'');
    expect(source).to.contain("case 'assistantContinuation'");
    expect(source).to.contain('appendResponseActions(');
    expect(source).to.contain('initComposerResize');
    expect(source).to.contain('resetComposerHeight');
    expect(source).to.contain('MAX_CONTINUATIONS');
    // The existing code-block Copy button is retained and tested.
    expect(source).to.contain('case \'copy-code\'');
    expect(source).to.contain('data-action="copy-code"');
    expect(html).to.not.contain('id="jump-latest" hidden="" aria-hidden="true"');
  });

  test('copy-response and continue-assistant wire through to the host protocol', () => {
    const source = script();
    expect(source).to.contain("post({ type: 'continueAssistant', id: id })");
    expect(source).to.contain("post({ type: 'copyLog' })");
    expect(source).to.contain("case 'assistantContinuation': {");
    expect(source).to.contain('state.continuationDepth');
    expect(source).to.contain('state.continuationBase');
  });

  test('every element the webview script looks up exists in the rendered HTML', () => {
    const html = render();
    const ids = [...script().matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
    expect(ids.length).to.be.greaterThan(15);

    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).to.deep.equal([]);
  });

  test('renders architecture and Karkain analysis sections from host messages', () => {
    const source = script();
    expect(source).to.contain('function renderArchitectureHtml(');
    expect(source).to.contain('function renderKarkainHtml(');
    expect(source).to.contain('renderArchitectureHtml(repository.architecture)');
    expect(source).to.contain('renderKarkainHtml(repository.karkain)');
    expect(source).to.contain("'<div class=\"impact-section\"><span class=\"impact-label\">Architecture</span>'");
    expect(source).to.contain("'<div class=\"impact-section\"><span class=\"impact-label\">Karkain project</span>'");
    expect(source).to.contain('<strong>Monorepo:</strong>');
    expect(source).to.contain('Framework');
  });

  test('exposes the agent inspection buttons the architecture UI relies on', () => {
    const html = render();
    expect(html).to.contain('data-action="inspect-repository"');
    expect(html).to.contain('data-action="summarize-workspace"');
    const source = script();
    expect(source).to.contain("post({ type: 'inspectRepository' })");
  });

  test('renders Git status inspection action and handler', () => {
    const html = render();
    expect(html).to.contain('data-action="inspect-git"');
    const source = script();
    expect(source).to.contain("case 'inspect-git'");
    expect(source).to.contain("post({ type: 'inspectGitStatus' })");
    expect(source).to.contain("case 'gitSnapshot'");
    expect(source).to.contain('renderGitStatusHtml(');
    expect(source).to.contain('Checkpoints');
    expect(source).to.contain('Git status');
  });

  test('renders execution cards with status, tests and diagnostics', () => {
    const source = script();
    expect(source).to.contain('function upsertExecutionCard(');
    expect(source).to.contain('case \'execution\'');
    expect(source).to.contain("case 'execution':");
    expect(source).to.contain("case 'executionHistory':");
    expect(source).to.contain('execution-badge');
    expect(source).to.contain('Tests:');
    expect(source).to.contain('Diagnostic');
  });

  test('handles every host message the extension can post about history and context', () => {
    const source = script();
    for (const type of ['history', 'requestContext', 'init', 'conversation', 'clear']) {
      expect(source).to.contain(`case '${type}'`);
    }
    expect(source).to.contain("post({ type: 'clearConversation' })");
    expect(source).to.contain("post({ type: 'restorePreviousConversation' })");
  });

  test('restores the selected conversation and labels the empty current chat', () => {
    const source = script();
    expect(source).to.contain("post({ type: 'restorePreviousConversation', id: selected })");
    expect(source).to.contain("'New chat — current, empty'");
    expect(source).to.contain('els.conversationSelect.value = matched ? state.activeConversationId');
  });

  test('binds every approval button to the pending request and renders validation outcomes', () => {
    const source = script();
    const approvalPosts = [
      "post({ type: 'approvePlan', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'rejectPlan', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'approveChangeSet', sessionId: sessionId, ids: changeIds, requestId: requestId })",
      "post({ type: 'rejectChangeSet', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'approveRepair', sessionId: sessionId, ids: repairIds, requestId: requestId })",
      "post({ type: 'rejectRepair', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'approveValidation', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'rejectValidation', sessionId: sessionId, requestId: requestId })",
      "post({ type: 'requestValidation', sessionId: sessionId, command: command })",
    ];
    for (const message of approvalPosts) {
      expect(source).to.contain(message);
    }
    expect((source.match(/data-request-id="/g) || []).length).to.equal(8);
    expect(source).to.contain("approval.kind === 'validation-command'");
    expect(source).to.contain("'approve-validation': true");
    expect(source).to.contain('Request validation');
    expect(source).to.contain('!session.pendingApproval');
    expect(source).to.contain('APPROVAL_ACTIONS[action] === true && !requestId');
    expect(source).to.contain('run.outcome');
    expect(source).to.contain('VALIDATION_OUTCOME_LABELS');
    expect(source).to.contain('run.detail');
    expect(source).to.contain('run.changeSetId');
    expect(source).to.not.contain("(evidence.passed ? 'ok' : 'bad')");
    expect(source).to.contain('session.validationSuggestions');
    expect(source).to.contain('session.progress');
  });

  test('escapes asset attributes to prevent markup injection', () => {
    const html = renderChatHtml({
      cspSource: 'source" onload="evil()',
      scriptUri: '"><script>alert(1)</script>',
      styleUri: '" style="background:url(https://evil.example)',
      nonce: '"><img src=x onerror=alert(1)>',
      version: '0.2.0',
    });

    expect(html).to.not.contain('<script>alert(1)</script>');
    expect(html).to.not.contain('<img src=x');
    expect(html).to.contain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).to.contain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).to.contain('&quot;');
  });
});
