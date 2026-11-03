(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const els = {
    messages: document.getElementById('messages'),
    empty: document.getElementById('empty'),
    emptySetKey: document.getElementById('empty-set-key'),
    prompt: document.getElementById('prompt'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    mode: document.getElementById('mode'),
    newChat: document.getElementById('new-chat'),
    deleteConversation: document.getElementById('delete-conversation'),
    conversationSelect: document.getElementById('conversation-select'),
    statusPill: document.getElementById('provider-status'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    attachmentBar: document.getElementById('attachment-bar'),
    clearAttachments: document.getElementById('clear-attachments'),
    contextBudget: document.getElementById('context-budget'),
    sessionSelect: document.getElementById('session-select'),
    toast: document.getElementById('toast'),
  };

  const state = {
    busy: false,
    attachments: [],
    status: null,
    maxPromptChars: 20000,
    streaming: null,
    pendingPrompt: null,
    conversations: [],
    activeConversationId: '',
    validationCommands: [],
    workspaceName: '',
    sessions: [],
    activeSessionId: '',
    session: null,
    changeSelections: {},
    repairSelections: {},
  };

  let toastTimer = 0;

  function post(message) {
    vscode.postMessage(message);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      switch (character) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function sanitizeLanguage(value) {
    const cleaned = String(value || 'text')
      .toLowerCase()
      .replace(/[^a-z0-9+#._-]/g, '');
    return cleaned || 'text';
  }

  function renderInline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^#{1,4}\s+(.+)$/gm, '<span class="md-heading">$1</span>');
    return html;
  }

  function renderMarkdown(text) {
    const source = String(text || '');
    let html = '';
    let lastIndex = 0;
    const fence = /```([A-Za-z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g;
    let match;

    while ((match = fence.exec(source)) !== null) {
      if (match.index > lastIndex) {
        html += '<div class="text">' + renderInline(source.slice(lastIndex, match.index)) + '</div>';
      }
      const language = sanitizeLanguage(match[1]);
      const code = match[2].replace(/\n$/, '');
      html +=
        '<div class="code-block">' +
        '<div class="code-head"><span class="code-language">' +
        escapeHtml(language) +
        '</span><button type="button" class="text-button" data-action="copy-code">Copy</button></div>' +
        '<pre class="code"><code class="language-' +
        escapeHtml(language) +
        '">' +
        escapeHtml(code) +
        '</code></pre></div>';
      lastIndex = fence.lastIndex;
    }

    if (lastIndex < source.length) {
      html += '<div class="text">' + renderInline(source.slice(lastIndex)) + '</div>';
    }

    return html || '<div class="text"></div>';
  }

  function diffHtml(diff) {
    return String(diff || '')
      .split('\n')
      .map(function (line) {
        let className = '';
        if (line.indexOf('+++') === 0 || line.indexOf('---') === 0) {
          className = 'diff-file';
        } else if (line.indexOf('@@') === 0) {
          className = 'diff-hunk';
        } else if (line.indexOf('+') === 0) {
          className = 'diff-add';
        } else if (line.indexOf('-') === 0) {
          className = 'diff-del';
        }
        return '<span' + (className ? ' class="' + className + '"' : '') + '>' + (line.length > 0 ? escapeHtml(line) : '&nbsp;') + '</span>';
      })
      .join('');
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function attachmentLabel(attachment) {
    if (attachment.isSelection && attachment.startLine) {
      const end = attachment.endLine || attachment.startLine;
      return attachment.path + ':' + attachment.startLine + '-' + end;
    }
    return attachment.path;
  }

  function setEmpty(visible) {
    els.empty.hidden = !visible;
  }

  function hasMessages() {
    return els.messages.querySelector('.message') !== null;
  }

  function isNearBottom() {
    const element = els.messages;
    return element.scrollHeight - element.scrollTop - element.clientHeight < 90;
  }

  function scrollToBottom(force) {
    if (force || isNearBottom()) {
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }

  function showToast(message, level) {
    els.toast.textContent = String(message);
    els.toast.className = 'toast ' + (level || 'info');
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      els.toast.hidden = true;
    }, 4500);
  }

  function setBusy(busy) {
    state.busy = busy;
    els.send.disabled = busy;
    els.stop.hidden = !busy;
    els.mode.disabled = busy;
    els.sessionSelect.disabled = busy;
    const buttons = document.querySelectorAll(
      '.quick-button, [data-action="attach-selection"], [data-action="attach-active"], [data-action="attach-files"], [data-action="attach-relevant"], [data-action="summarize-workspace"], [data-action="clear-attachments"]',
    );
    buttons.forEach(function (button) {
      button.disabled = busy;
    });
  }

  function renderStatus() {
    const status = state.status;
    els.emptySetKey.hidden = true;

    if (!status) {
      els.statusPill.dataset.state = '';
      els.statusText.textContent = 'Loading provider…';
      els.statusPill.title = 'Loading QuantsMind provider status';
      return;
    }

    if (status.configurationError) {
      els.statusPill.dataset.state = 'error';
      els.statusText.textContent = 'Provider needs configuration';
      els.statusPill.title = status.configurationError + '\nClick to open provider settings.';
      return;
    }

    if (status.credentialRequired && !status.hasCredential) {
      els.statusPill.dataset.state = 'warn';
      els.statusText.textContent = 'API key required';
      els.statusPill.title = 'No API key is stored. Click to set one securely.';
      els.emptySetKey.hidden = false;
      return;
    }

    els.statusPill.dataset.state = 'ok';
    els.statusText.textContent = status.model + ' · ' + status.endpointHost;
    els.statusPill.title = [
      status.displayName,
      'Model: ' + status.model,
      'Endpoint: ' + status.endpointHost,
      status.hasCredential ? 'API key stored in VS Code SecretStorage' : 'No API key required',
      'Click to open provider settings.',
    ].join('\n');
  }

  function renderWorkspace() {
    if (state.workspaceName) {
      els.workspaceName.textContent = state.workspaceName;
      els.workspaceName.title = 'Workspace: ' + state.workspaceName;
    } else {
      els.workspaceName.textContent = 'No workspace';
      els.workspaceName.title = 'Open a folder to enable workspace retrieval and agent mode';
    }
  }

  function renderConversationSelect() {
    const list = state.conversations || [];
    els.conversationSelect.replaceChildren();

    const fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = 'New chat';
    els.conversationSelect.append(fresh);

    let matched = false;
    list.forEach(function (conversation) {
      const option = document.createElement('option');
      option.value = conversation.id;
      const count = conversation.messageCount > 0 ? ' (' + conversation.messageCount + ')' : '';
      option.textContent = conversation.title + count;
      if (conversation.id === state.activeConversationId) {
        matched = true;
        option.selected = true;
      }
      els.conversationSelect.append(option);
    });

    if (!matched) {
      fresh.selected = true;
    }
    els.deleteConversation.hidden = !state.activeConversationId;
  }

  function updateModeUi() {
    const agent = els.mode.value === 'agent';
    els.prompt.placeholder = agent
      ? 'Describe the requirement. The agent inspects, plans, and waits for your approval.'
      : 'Ask about your code. Nothing is sent until you press Send.';
    els.privacyNote.textContent = agent
      ? 'Agent sessions send only retrieved, redacted files. Plan, change-set and repair approvals are separate; validation runs only allowlisted commands without a shell.'
      : 'Only attached content is sent. Ask/Explain/Generate never modify files.';
  }

  function renderAttachmentBar() {
    els.attachmentBar.replaceChildren();
    const attachments = state.attachments || [];
    els.attachmentBar.hidden = attachments.length === 0;
    els.clearAttachments.hidden = attachments.length === 0;

    let totalChars = 0;
    let redactions = 0;

    attachments.forEach(function (attachment) {
      totalChars += attachment.chars || 0;
      redactions += attachment.redactions || 0;

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = attachmentLabel(attachment);

      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = attachmentLabel(attachment);

      const meta = document.createElement('span');
      meta.className = 'chip-meta';
      meta.textContent = formatNumber(attachment.chars) + ' ch';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.dataset.remove = attachment.id;
      remove.title = 'Remove attachment';
      remove.setAttribute('aria-label', 'Remove ' + attachmentLabel(attachment));
      remove.textContent = '×';

      chip.append(label, meta, remove);
      els.attachmentBar.append(chip);
    });

    if (attachments.length === 0) {
      els.contextBudget.textContent = '';
      return;
    }

    let budget = attachments.length + (attachments.length === 1 ? ' file · ' : ' files · ');
    budget += formatNumber(totalChars) + ' chars';
    if (redactions > 0) {
      budget += ' · ' + redactions + ' redacted';
    }
    els.contextBudget.textContent = budget;
    els.contextBudget.title =
      'Secrets detected in attached content are redacted before sending.';
  }

  function appendAttachmentChips(container, attachments) {
    if (!attachments || attachments.length === 0) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'message-attachments';

    attachments.forEach(function (attachment) {
      const chip = document.createElement('span');
      chip.className = 'chip static';
      chip.title = attachmentLabel(attachment);
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = attachmentLabel(attachment);
      const meta = document.createElement('span');
      meta.className = 'chip-meta';
      meta.textContent = formatNumber(attachment.chars) + ' ch';
      chip.append(label, meta);
      wrapper.append(chip);
    });

    container.append(wrapper);
  }

  function appendLabelChips(container, labels) {
    if (!labels || labels.length === 0) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'message-attachments';
    labels.forEach(function (labelText) {
      const chip = document.createElement('span');
      chip.className = 'chip static';
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = labelText;
      chip.append(label);
      wrapper.append(chip);
    });
    container.append(wrapper);
  }

  function appendUserMessage(text, attachments, labels) {
    const article = document.createElement('article');
    article.className = 'message user';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'You';

    const bubble = document.createElement('div');
    bubble.className = 'user-body message-content';
    bubble.innerHTML = renderMarkdown(text);

    article.append(label, bubble);
    appendAttachmentChips(article, attachments);
    appendLabelChips(article, labels);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);
  }

  function appendAssistantStatic(text, heading) {
    const article = document.createElement('article');
    article.className = 'message assistant';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = heading || 'QuantsMind';

    const card = document.createElement('div');
    card.className = 'assistant-card';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMarkdown(text);

    card.append(content);
    article.append(label, card);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);
  }

  function createAssistantMessage(model) {
    const article = document.createElement('article');
    article.className = 'message assistant streaming';

    const label = document.createElement('div');
    label.className = 'message-label';
    const name = document.createElement('span');
    name.textContent = 'QuantsMind';
    const modelName = document.createElement('span');
    modelName.className = 'model';
    modelName.textContent = model;
    label.append(name, modelName);

    const card = document.createElement('div');
    card.className = 'assistant-card';

    const content = document.createElement('div');
    content.className = 'message-content';

    card.append(content);
    article.append(label, card);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);

    return { article, card, content };
  }

  function startStreaming(id, model) {
    if (state.streaming) {
      finishStreaming(state.streaming.id, 'Interrupted.', false);
    }
    const element = createAssistantMessage(model);
    state.streaming = {
      id: id,
      text: '',
      article: element.article,
      card: element.card,
      content: element.content,
      frame: 0,
    };
  }

  function scheduleRender() {
    const streaming = state.streaming;
    if (!streaming || streaming.frame) {
      return;
    }
    const stick = isNearBottom();
    streaming.frame = window.requestAnimationFrame(function () {
      streaming.frame = 0;
      if (state.streaming !== streaming) {
        return;
      }
      streaming.content.innerHTML = renderMarkdown(streaming.text);
      if (stick) {
        scrollToBottom(true);
      }
    });
  }

  function finishStreaming(id, metaText, cancelled) {
    const streaming = state.streaming;
    if (!streaming) {
      return;
    }
    if (id && streaming.id !== id) {
      return;
    }
    if (streaming.frame) {
      window.cancelAnimationFrame(streaming.frame);
      streaming.frame = 0;
    }
    streaming.content.innerHTML = renderMarkdown(streaming.text);
    streaming.article.classList.remove('streaming');
    if (cancelled) {
      streaming.article.classList.add('cancelled');
    }
    if (metaText) {
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.textContent = metaText;
      streaming.card.append(meta);
    }
    state.streaming = null;
    scrollToBottom(false);
  }

  function appendError(message) {
    if (state.streaming) {
      finishStreaming(state.streaming.id, 'Interrupted.', false);
    }

    const article = document.createElement('article');
    article.className = 'message error';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'Request failed';

    const card = document.createElement('div');
    card.className = 'error-card';

    const title = document.createElement('p');
    title.className = 'error-title';
    title.textContent = 'QuantsMind could not complete the request';

    const text = document.createElement('p');
    text.className = 'error-message';
    text.textContent = message.message || 'An unexpected error occurred.';

    card.append(title, text);

    if (message.hint) {
      const hint = document.createElement('p');
      hint.className = 'error-hint';
      hint.textContent = message.hint;
      card.append(hint);
    }

    const actions = document.createElement('div');
    actions.className = 'error-actions';

    if (message.code === 'authentication') {
      const setKey = document.createElement('button');
      setKey.type = 'button';
      setKey.className = 'action-button';
      setKey.dataset.action = 'set-key';
      setKey.textContent = 'Set API key';
      actions.append(setKey);
    }

    if (message.code === 'configuration') {
      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'action-button';
      settings.dataset.action = 'open-settings';
      settings.textContent = 'Open provider settings';
      actions.append(settings);
    }

    const log = document.createElement('button');
    log.type = 'button';
    log.className = 'action-button';
    log.dataset.action = 'show-log';
    log.textContent = 'Show log';
    actions.append(log);

    card.append(actions);

    if (message.code) {
      const code = document.createElement('div');
      code.className = 'error-code';
      const codeValue = document.createElement('code');
      codeValue.textContent = message.code;
      code.append('Code: ', codeValue);
      card.append(code);
    }

    article.append(label, card);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);
  }

  var SESSION_STATE_LABELS = {
    idle: 'Queued',
    analyzing: 'Analyzing requirement',
    inspecting: 'Inspecting project',
    planning: 'Planning',
    'awaiting-plan-approval': 'Plan awaiting approval',
    ready: 'Ready',
    executing: 'Executing task',
    'awaiting-change-approval': 'Changes awaiting approval',
    applying: 'Applying approved changes',
    validating: 'Validation pending',
    diagnosing: 'Diagnosing failure',
    'awaiting-repair-approval': 'Repair awaiting approval',
    repairing: 'Applying repair',
    paused: 'Paused',
    cancelling: 'Cancelling',
    completed: 'Completed',
    rejected: 'Rejected',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  var SESSION_STAGE_LABELS = {
    requirement: 'Requirement',
    inspect: 'Inspect project',
    plan: 'Plan',
    'plan-approval': 'Plan approval',
    tasks: 'Tasks',
    review: 'Change review',
    apply: 'Apply',
    validate: 'Validate',
    repair: 'Repair',
    report: 'Evidence report',
  };

  var TASK_STATUS_LABELS = {
    pending: 'Pending',
    blocked: 'Blocked',
    running: 'Running',
    'awaiting-approval': 'Awaiting approval',
    applied: 'Applied',
    'validation-failed': 'Validation failed',
    repairing: 'Repairing',
    completed: 'Completed',
    failed: 'Failed',
    skipped: 'Skipped',
    cancelled: 'Cancelled',
  };

  var PAUSEABLE_STATES = {
    ready: true,
    'awaiting-plan-approval': true,
    'awaiting-change-approval': true,
    'awaiting-repair-approval': true,
    diagnosing: true,
  };

  function isTerminalState(session) {
    return (
      session.state === 'completed' ||
      session.state === 'failed' ||
      session.state === 'rejected' ||
      session.state === 'cancelled'
    );
  }

  function selectedChangeIds(sessionId, changes) {
    if (!state.changeSelections[sessionId]) {
      state.changeSelections[sessionId] = {};
      (changes || []).forEach(function (change) {
        state.changeSelections[sessionId][change.id] = true;
      });
    }
    return state.changeSelections[sessionId];
  }

  function selectedRepairIds(sessionId, changes) {
    if (!state.repairSelections[sessionId]) {
      state.repairSelections[sessionId] = {};
      (changes || []).forEach(function (change) {
        state.repairSelections[sessionId][change.id] = true;
      });
    }
    return state.repairSelections[sessionId];
  }

  function renderReviewCard(change, editable, selection, checkAttribute) {
    var attribute = checkAttribute || 'data-change-check';
    var renameLabel =
      change.kind === 'rename' && change.fromPath
        ? change.fromPath + ' → ' + change.path
        : change.path;
    var checked = selection[change.id] ? ' checked' : '';
    return (
      '<div class="review-card" data-change-id="' + escapeHtml(change.id) + '">' +
      '<label class="review-head">' +
      '<input type="checkbox" ' + attribute + '="' + escapeHtml(change.id) + '"' + checked + (editable ? '' : ' disabled') + ' />' +
      '<span class="change-kind kind-' + escapeHtml(change.kind) + '">' + escapeHtml(change.kind) + '</span>' +
      '<span class="change-path" title="' + escapeHtml(renameLabel) + '">' + escapeHtml(renameLabel) + '</span>' +
      '<span class="change-stat">+' + Number(change.additions || 0) + ' −' + Number(change.deletions || 0) + '</span>' +
      '</label>' +
      (change.summary ? '<p class="change-summary">' + escapeHtml(change.summary) + '</p>' : '') +
      (change.warning ? '<p class="change-warning">' + escapeHtml(change.warning) + '</p>' : '') +
      '<pre class="diff">' + diffHtml(change.diff || '') + '</pre>' +
      (change.diffTruncated ? '<p class="change-warning">The diff was truncated; the full file content is still part of the plan.</p>' : '') +
      '</div>'
    );
  }

  function reviewFromChangeSet(changeSet) {
    var diffs = changeSet.diffs || [];
    return (changeSet.plan && changeSet.plan.changes ? changeSet.plan.changes : []).map(
      function (change) {
        var diff = diffs.find(function (candidate) {
          return candidate.path === change.path;
        }) || {};
        return {
          id: change.id,
          kind: change.kind,
          path: change.path,
          fromPath: change.fromPath,
          summary: change.summary,
          diff: diff.text || '',
          additions: diff.additions || 0,
          deletions: diff.deletions || 0,
          diffTruncated: Boolean(diff.truncated),
        };
      },
    );
  }

  function reviewFromRepair(proposal) {
    var diffs = proposal.diffs || [];
    return (proposal.plan && proposal.plan.changes ? proposal.plan.changes : []).map(
      function (change) {
        var diff = diffs.find(function (candidate) {
          return candidate.path === change.path;
        }) || {};
        return {
          id: change.id,
          kind: change.kind,
          path: change.path,
          fromPath: change.fromPath,
          summary: change.summary,
          diff: diff.text || '',
          additions: diff.additions || 0,
          deletions: diff.deletions || 0,
          diffTruncated: Boolean(diff.truncated),
        };
      },
    );
  }

  function renderStages(stages) {
    return (stages || [])
      .map(function (stage) {
        return (
          '<li class="stage ' + escapeHtml(stage.status) + '">' +
          '<span class="stage-dot" aria-hidden="true"></span>' +
          '<span class="stage-name">' + escapeHtml(SESSION_STAGE_LABELS[stage.name] || stage.name) + '</span>' +
          (stage.detail ? '<span class="stage-detail">' + escapeHtml(stage.detail) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
  }

  function renderPlan(session) {
    var plan = session.plan;
    if (!plan) {
      return '';
    }
    var tasks = (plan.tasks || [])
      .map(function (task) {
        var criteria = (task.acceptanceCriteria || [])
          .map(function (criterion) {
            return '<li>' + escapeHtml(criterion.text) + ' <span class="criterion-kind">(' + escapeHtml(criterion.verification) + ')</span></li>';
          })
          .join('');
        return (
          '<li class="plan-task status-' + escapeHtml(task.status) + '">' +
          '<div class="plan-task-head">' +
          '<span class="plan-task-title">' + escapeHtml(task.title) + '</span>' +
          '<span class="plan-task-status">' + escapeHtml(TASK_STATUS_LABELS[task.status] || task.status) + '</span>' +
          '</div>' +
          (task.description ? '<p class="plan-task-description">' + escapeHtml(task.description) + '</p>' : '') +
          (task.dependsOn && task.dependsOn.length > 0
            ? '<p class="plan-task-meta">Depends on: ' + escapeHtml(task.dependsOn.join(', ')) + '</p>'
            : '') +
          (task.validationCommand
            ? '<p class="plan-task-meta">Validation: <code>' + escapeHtml(task.validationCommand) + '</code></p>'
            : '') +
          (criteria ? '<ul class="plan-criteria">' + criteria + '</ul>' : '') +
          (task.error ? '<p class="task-error">' + escapeHtml(task.error) + '</p>' : '') +
          '</li>'
        );
      })
      .join('');
    var risks = (plan.risks || [])
      .map(function (risk) {
        return '<li>' + escapeHtml(risk) + '</li>';
      })
      .join('');
    var warnings = (plan.warnings || [])
      .map(function (warning) {
        return '<p class="change-warning">' + escapeHtml(warning) + '</p>';
      })
      .join('');
    return (
      '<div class="plan-card">' +
      '<p class="plan-summary">' + escapeHtml(plan.summary) + '</p>' +
      (plan.approach ? '<p class="plan-approach">' + escapeHtml(plan.approach) + '</p>' : '') +
      (risks ? '<div class="plan-risks"><span class="plan-risks-label">Risks</span><ul>' + risks + '</ul></div>' : '') +
      warnings +
      (tasks ? '<ul class="plan-tasks">' + tasks + '</ul>' : '<p class="task-notes">The plan contains no tasks.</p>') +
      '</div>'
    );
  }

  function renderValidations(session) {
    return (session.validationRuns || [])
      .map(function (run) {
        var evidence = run.evidence || {};
        var stateLabel = evidence.cancelled
          ? 'cancelled'
          : evidence.timedOut
            ? 'timed out'
            : 'exit ' + (evidence.exitCode === null ? 'unknown' : evidence.exitCode);
        return (
          '<div class="validation ' + (evidence.passed ? 'ok' : 'bad') + '">' +
          '<div class="validation-head"><span class="validation-command">' + escapeHtml(evidence.command || run.command) + '</span>' +
          '<span class="validation-state">' + escapeHtml(stateLabel) + ' · ' + formatNumber(evidence.durationMs) + ' ms</span></div>' +
          '<pre class="command-output">' + escapeHtml(evidence.output || '(no output)') + '</pre>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderDiagnostics(session) {
    var diagnostics = session.diagnostics || [];
    if (diagnostics.length === 0) {
      return '';
    }
    var items = diagnostics
      .map(function (diagnostic) {
        var location = diagnostic.file
          ? diagnostic.file + (diagnostic.line ? ':' + diagnostic.line : '')
          : '';
        return (
          '<li class="diagnostic severity-' + escapeHtml(diagnostic.severity) + '">' +
          '<span class="diagnostic-source">' + escapeHtml(diagnostic.source) + '</span>' +
          '<span class="diagnostic-message">' + escapeHtml(diagnostic.message) + '</span>' +
          (location ? '<span class="diagnostic-location">' + escapeHtml(location) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    return '<div class="diagnostic-list"><span class="section-label">Diagnostics</span><ul>' + items + '</ul></div>';
  }

  function renderReport(session) {
    var report = session.report;
    if (!report) {
      return '';
    }
    var evidence = (report.evidence || [])
      .map(function (line) {
        return '<li>' + escapeHtml(line) + '</li>';
      })
      .join('');
    var unresolved = (report.unresolved || [])
      .map(function (line) {
        return '<li>' + escapeHtml(line) + '</li>';
      })
      .join('');
    return (
      '<div class="report-card outcome-' + escapeHtml(report.outcome) + '">' +
      '<div class="report-head"><span class="report-outcome">' + escapeHtml(report.outcome) + '</span>' +
      '<span class="report-meta">' + Number(report.repairs || 0) + ' repair proposal(s)</span></div>' +
      (evidence ? '<div class="report-section"><span class="section-label">Evidence</span><ul>' + evidence + '</ul></div>' : '<p class="task-notes">No command evidence was collected.</p>') +
      (unresolved ? '<div class="report-section"><span class="section-label">Unresolved</span><ul>' + unresolved + '</ul></div>' : '') +
      '</div>'
    );
  }

  function renderSessionApproval(session) {
    var approval = session.pendingApproval;
    if (!approval) {
      return '';
    }
    var sessionId = escapeHtml(session.id);
    if (approval.kind === 'plan') {
      return (
        '<div class="approval-card">' +
        '<div class="approval-head"><span class="approval-kind">Plan approval</span>' +
        '<span class="approval-title">' + escapeHtml(approval.title) + '</span></div>' +
        (approval.detail ? '<p class="approval-detail">' + escapeHtml(approval.detail) + '</p>' : '') +
        '<p class="task-notes">No files will be written until you approve the plan and then approve individual changes.</p>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-plan" data-session-id="' + sessionId + '">Approve plan</button>' +
        '<button type="button" class="action-button" data-session-action="reject-plan" data-session-id="' + sessionId + '">Reject plan</button>' +
        '</div></div>'
      );
    }

    if (approval.kind === 'change-set') {
      var changeSet = (session.changeSets || []).find(function (candidate) {
        return candidate.id === approval.subjectId;
      });
      if (!changeSet) {
        return '<div class="approval-card"><p class="task-error">The pending change set is missing.</p></div>';
      }
      var changes = reviewFromChangeSet(changeSet);
      var selection = selectedChangeIds(session.id, changes);
      var reviews = changes
        .map(function (change) {
          return renderReviewCard(change, true, selection, 'data-change-check');
        })
        .join('');
      return (
        '<div class="approval-card">' +
        '<div class="approval-head"><span class="approval-kind">Change-set approval</span>' +
        '<span class="approval-title">' + escapeHtml(changeSet.summary) + '</span></div>' +
        '<p class="task-notes">Select the files to apply. Backups are created for every applied file.</p>' +
        '<div class="review-list" data-session-reviews="' + sessionId + '">' + reviews + '</div>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-change-selected" data-session-id="' + sessionId + '">Apply selected files</button>' +
        '<button type="button" class="action-button" data-session-action="reject-change" data-session-id="' + sessionId + '">Reject change set</button>' +
        '</div></div>'
      );
    }

    if (approval.kind === 'repair') {
      var proposal = (session.repairProposals || []).find(function (candidate) {
        return candidate.id === approval.subjectId;
      });
      if (!proposal) {
        return '<div class="approval-card"><p class="task-error">The pending repair proposal is missing.</p></div>';
      }
      var repairChanges = reviewFromRepair(proposal);
      var repairSelection = selectedRepairIds(session.id, repairChanges);
      var repairReviews = repairChanges
        .map(function (change) {
          return renderReviewCard(change, true, repairSelection, 'data-repair-check');
        })
        .join('');
      return (
        '<div class="approval-card">' +
        '<div class="approval-head"><span class="approval-kind">Repair approval</span>' +
        '<span class="approval-title">' + escapeHtml(proposal.summary) + '</span></div>' +
        (proposal.diagnosis ? '<p class="approval-detail">' + escapeHtml(proposal.diagnosis) + '</p>' : '') +
        '<div class="review-list" data-session-repairs="' + sessionId + '">' + repairReviews + '</div>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-repair-selected" data-session-id="' + sessionId + '">Apply repair</button>' +
        '<button type="button" class="action-button" data-session-action="reject-repair" data-session-id="' + sessionId + '">Reject repair</button>' +
        '</div></div>'
      );
    }

    return '';
  }

  function renderSessionActions(session) {
    var sessionId = escapeHtml(session.id);
    var actions = '';
    if (PAUSEABLE_STATES[session.state]) {
      actions +=
        '<button type="button" class="action-button" data-session-action="pause" data-session-id="' +
        sessionId +
        '">Pause</button>';
    }
    if (session.state === 'paused') {
      if (!session.needsReview) {
        actions +=
          '<button type="button" class="action-button primary" data-session-action="resume" data-session-id="' +
          sessionId +
          '">Resume</button>';
      }
    }
    if (session.needsReview) {
      actions +=
        '<button type="button" class="action-button primary" data-session-action="restore" data-session-id="' +
        sessionId +
        '">Restore and revalidate</button>';
    }
    if (session.state === 'validating' && state.validationCommands.length > 0) {
      var options = state.validationCommands
        .map(function (command) {
          return '<option value="' + escapeHtml(command) + '">' + escapeHtml(command) + '</option>';
        })
        .join('');
      actions +=
        '<span class="validation-picker">' +
        '<select data-session-validation aria-label="Validation command">' + options + '</select>' +
        '<button type="button" class="action-button primary" data-session-action="run-validation" data-session-id="' +
        sessionId +
        '">Run validation</button>' +
        '</span>';
    }
    if (session.state === 'diagnosing') {
      actions +=
        '<button type="button" class="action-button primary" data-session-action="plan-repair" data-session-id="' +
        sessionId +
        '">Plan a repair</button>';
    }
    var hasApply = (session.executions || []).some(function (execution) {
      return Boolean(execution.historyTaskId);
    });
    if (hasApply) {
      actions +=
        '<button type="button" class="action-button" data-session-action="undo" data-session-id="' +
        sessionId +
        '">Undo last apply</button>';
    }
    if (!isTerminalState(session)) {
      actions +=
        '<button type="button" class="action-button" data-session-action="cancel" data-session-id="' +
        sessionId +
        '">Cancel session</button>';
    }
    actions +=
      '<button type="button" class="action-button subtle" data-session-action="delete" data-session-id="' +
      sessionId +
      '">Delete session</button>';
    return actions ? '<div class="task-actions session-actions">' + actions + '</div>' : '';
  }

  function buildSessionArticle(session) {
    var meta = [
      'Provider calls: ' + Number(session.providerCalls || 0),
      'Updated: ' + String(session.updatedAt || '').replace('T', ' ').slice(0, 19),
    ].join(' · ');
    var warnings = (session.plan && session.plan.warnings ? session.plan.warnings : [])
      .map(function (warning) {
        return '<p class="change-warning">' + escapeHtml(warning) + '</p>';
      })
      .join('');
    var appliedSets = (session.changeSets || [])
      .filter(function (changeSet) {
        return !session.pendingApproval || session.pendingApproval.subjectId !== changeSet.id;
      })
      .map(function (changeSet) {
        var changes = reviewFromChangeSet(changeSet);
        var selection = selectedChangeIds(session.id, changes);
        var reviews = changes
          .map(function (change) {
            return renderReviewCard(change, false, selection, 'data-change-check');
          })
          .join('');
        return (
          '<div class="applied-set"><span class="section-label">Approved change set</span>' +
          '<div class="review-list">' + reviews + '</div></div>'
        );
      })
      .join('');

    var html =
      '<div class="task-card session-card state-' + escapeHtml(session.state) + '">' +
      '<div class="task-head">' +
      '<span class="task-status">Session · ' + escapeHtml(SESSION_STATE_LABELS[session.state] || session.state) + '</span>' +
      '<span class="task-meta">' + escapeHtml(meta) + '</span>' +
      '</div>' +
      '<p class="session-requirement">' + escapeHtml(session.requirement ? session.requirement.text : '') + '</p>' +
      (session.needsReview ? '<p class="change-warning">This session needs review before it can continue. Restore revalidates every applied file hash.</p>' : '') +
      (session.error ? '<p class="task-error">' + escapeHtml(session.error) + '</p>' : '') +
      '<ul class="task-stages">' + renderStages(session.stages) + '</ul>' +
      renderPlan(session) +
      warnings +
      renderSessionApproval(session) +
      appliedSets +
      renderValidations(session) +
      renderDiagnostics(session) +
      renderReport(session) +
      renderSessionActions(session) +
      '</div>';

    var article = document.createElement('article');
    article.className = 'message session';
    article.dataset.sessionId = session.id;

    var label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'Agent session';

    var body = document.createElement('div');
    body.className = 'task-body session-body';
    body.innerHTML = html;

    article.append(label, body);
    return article;
  }

  function renderSession(session) {
    if (!session || typeof session.id !== 'string') {
      return;
    }
    state.session = session;
    state.activeSessionId = session.id;
    var article = buildSessionArticle(session);
    var existing = Array.prototype.find.call(
      els.messages.querySelectorAll('[data-session-id]'),
      function (node) {
        return node.dataset.sessionId === session.id;
      },
    );
    if (existing) {
      var stick = isNearBottom();
      existing.replaceWith(article);
      if (stick) {
        scrollToBottom(true);
      }
      renderSessionSelect();
    } else {
      els.messages.append(article);
      setEmpty(false);
      scrollToBottom(true);
      renderSessionSelect();
    }
  }

  function renderSessionSelect() {
    var sessions = state.sessions || [];
    els.sessionSelect.replaceChildren();
    var fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = sessions.length === 0 ? 'No active session' : 'No session selected';
    els.sessionSelect.append(fresh);

    let matched = false;
    sessions.forEach(function (session) {
      var option = document.createElement('option');
      option.value = session.id;
      var progress =
        session.taskCount > 0
          ? ' · ' + session.completedTasks + '/' + session.taskCount
          : '';
      option.textContent =
        (SESSION_STATE_LABELS[session.state] || session.state) + progress + ' — ' + session.requirement;
      if (session.id === state.activeSessionId) {
        matched = true;
        option.selected = true;
      }
      els.sessionSelect.append(option);
    });

    if (!matched) {
      fresh.selected = true;
    }
  }

  function removeSessionCard(sessionId) {
    els.messages.querySelectorAll('[data-session-id]').forEach(function (node) {
      if (node.dataset.sessionId === sessionId) {
        node.remove();
      }
    });
    if (state.activeSessionId === sessionId) {
      state.activeSessionId = '';
      state.session = null;
    }
    setEmpty(!hasMessages());
    renderSessionSelect();
  }

  function renderTranscript(transcript) {
    state.streaming = null;
    els.messages.querySelectorAll('.message').forEach(function (node) {
      node.remove();
    });
    var items = Array.isArray(transcript) ? transcript : [];
    items.forEach(function (message) {
      if (message.role === 'user') {
        appendUserMessage(message.text || '', [], message.attachments || []);
      } else if (message.role === 'assistant') {
        appendAssistantStatic(message.text || '');
      }
    });
    if (state.session) {
      renderSession(state.session);
    }
    setEmpty(!hasMessages());
    autoResize();
    scrollToBottom(true);
  }

  function clearConversation() {
    state.streaming = null;
    state.pendingPrompt = null;
    state.attachments = [];
    state.busy = false;
    state.session = null;
    state.activeSessionId = '';
    state.changeSelections = {};
    state.repairSelections = {};
    els.messages.querySelectorAll('.message').forEach(function (node) {
      node.remove();
    });
    els.prompt.value = '';
    els.mode.value = 'ask';
    autoResize();
    updateModeUi();
    renderAttachmentBar();
    renderSessionSelect();
    setBusy(false);
    setEmpty(true);
  }

  function autoResize() {
    els.prompt.style.height = 'auto';
    const height = Math.min(240, Math.max(58, els.prompt.scrollHeight));
    els.prompt.style.height = height + 'px';
  }

  function submit() {
    if (state.busy) {
      return;
    }

    const prompt = els.prompt.value.trim();
    const mode = els.mode.value;
    if (prompt.length === 0 && (mode === 'agent' || state.attachments.length === 0)) {
      showToast(
        mode === 'agent'
          ? 'Describe the change you want before starting an agent task.'
          : 'Add a question or attach code first.',
        'warn',
      );
      els.prompt.focus();
      return;
    }
    if (prompt.length > state.maxPromptChars) {
      showToast('The prompt is too long. Shorten it before sending.', 'warn');
      return;
    }

    if (mode === 'agent') {
      if (state.attachments.length > 0) {
        showToast('Agent mode retrieves workspace files itself; attachments are not sent.', 'info');
      }
      post({ type: 'startSession', requirement: prompt });
      els.prompt.value = '';
      autoResize();
      return;
    }

    state.pendingPrompt = els.prompt.value;
    post({ type: 'send', prompt: els.prompt.value, mode: mode });
    els.prompt.value = '';
    autoResize();
  }

  function handleMessage(message) {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'init': {
        state.status = message.status;
        state.attachments = Array.isArray(message.attachments) ? message.attachments : [];
        state.maxPromptChars = message.maxPromptChars || 20000;
        state.conversations = Array.isArray(message.conversations) ? message.conversations : [];
        state.activeConversationId = message.activeConversationId || '';
        state.validationCommands = Array.isArray(message.validationCommands)
          ? message.validationCommands
          : [];
        state.workspaceName = message.workspaceName || '';
        state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        state.activeSessionId = message.activeSessionId || '';
        state.session = null;
        if (message.version) {
          document.title = 'QuantsMind AI Coder ' + message.version;
        }
        renderStatus();
        renderWorkspace();
        renderConversationSelect();
        renderSessionSelect();
        renderAttachmentBar();
        updateModeUi();
        if (!hasMessages()) {
          renderTranscript(message.transcript || []);
        }
        setEmpty(!hasMessages());
        break;
      }
      case 'status': {
        state.status = message.status;
        renderStatus();
        break;
      }
      case 'attachments': {
        state.attachments = Array.isArray(message.attachments) ? message.attachments : [];
        renderAttachmentBar();
        break;
      }
      case 'draft': {
        state.attachments = Array.isArray(message.attachments) ? message.attachments : [];
        els.mode.value = message.mode || 'ask';
        updateModeUi();
        if (typeof message.prompt === 'string' && message.prompt.length > 0) {
          els.prompt.value = message.prompt;
        }
        renderAttachmentBar();
        if (els.prompt.value.length > 0 || state.attachments.length > 0) {
          setEmpty(false);
        }
        autoResize();
        els.prompt.focus();
        scrollToBottom(true);
        break;
      }
      case 'userMessage': {
        state.pendingPrompt = null;
        appendUserMessage(message.text || '', message.attachments || [], []);
        break;
      }
      case 'assistantStart': {
        startStreaming(message.id, message.model || '');
        break;
      }
      case 'assistantDelta': {
        if (state.streaming && state.streaming.id === message.id) {
          state.streaming.text += message.delta || '';
          scheduleRender();
        }
        break;
      }
      case 'assistantEnd': {
        if (state.streaming && state.streaming.id === message.id) {
          const parts = [];
          if (message.usage && typeof message.usage.totalTokens === 'number') {
            parts.push(formatNumber(message.usage.totalTokens) + ' tokens');
          }
          if (message.finishReason === 'length') {
            parts.push('truncated at token limit');
          } else if (message.finishReason) {
            parts.push(message.finishReason);
          }
          finishStreaming(message.id, parts.join(' · '), false);
        }
        break;
      }
      case 'assistantCancelled': {
        finishStreaming(message.id, 'Stopped by you.', true);
        break;
      }
      case 'error': {
        if (state.pendingPrompt !== null) {
          els.prompt.value = state.pendingPrompt;
          state.pendingPrompt = null;
          autoResize();
          els.prompt.focus();
        }
        appendError(message);
        break;
      }
      case 'busy': {
        setBusy(Boolean(message.busy));
        break;
      }
      case 'notice': {
        showToast(message.message || '', message.level || 'info');
        break;
      }
      case 'clear': {
        clearConversation();
        break;
      }
      case 'conversations': {
        state.conversations = Array.isArray(message.conversations) ? message.conversations : [];
        state.activeConversationId = message.activeConversationId || state.activeConversationId;
        renderConversationSelect();
        break;
      }
      case 'conversation': {
        state.activeConversationId = message.id || '';
        renderConversationSelect();
        renderTranscript(message.transcript || []);
        break;
      }
      case 'session': {
        renderSession(message.session);
        break;
      }
      case 'sessions': {
        state.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        if (typeof message.activeSessionId === 'string') {
          state.activeSessionId = message.activeSessionId;
        }
        renderSessionSelect();
        break;
      }
      case 'sessionRemoved': {
        removeSessionCard(message.id || '');
        break;
      }
      case 'sessionError': {
        showToast(message.message || 'The agent session failed.', 'warn');
        appendError({ message: message.message, hint: message.hint });
        break;
      }
      case 'workspaceSummary': {
        var header =
          'Workspace summary · ' + Number(message.fileCount || 0) + ' file(s)' +
          (message.truncated ? ' · truncated' : '');
        appendAssistantStatic(message.text || '', header);
        showToast('Workspace summarized locally. Nothing was sent to the provider.', 'info');
        break;
      }
      case 'undoResult': {
        showToast(
          message.conflicts > 0
            ? 'Undo restored ' + message.restored + ' file(s); ' + message.conflicts + ' conflict(s) were left untouched.'
            : 'Undo restored ' + message.restored + ' file(s) from backups.',
          message.conflicts > 0 ? 'warn' : 'info',
        );
        break;
      }
      case 'commandOutput': {
        showToast(
          'Validation finished (' +
            (message.command || 'command') +
            '): ' +
            (message.timedOut
              ? 'timed out'
              : message.cancelled
                ? 'cancelled'
                : 'exit ' + (message.exitCode === null ? 'unknown' : message.exitCode)),
          message.timedOut || message.cancelled ? 'warn' : message.exitCode === 0 ? 'info' : 'warn',
        );
        break;
      }
      default:
        break;
    }
  }

  function handleSessionAction(button) {
    var sessionId = button.dataset.sessionId;
    var action = button.dataset.sessionAction;
    if (!sessionId) {
      return;
    }
    var body = button.closest('.session-body');

    switch (action) {
      case 'approve-plan':
        post({ type: 'approvePlan', sessionId: sessionId });
        break;
      case 'reject-plan':
        post({ type: 'rejectPlan', sessionId: sessionId });
        break;
      case 'approve-change-selected': {
        var changeIds = body
          ? Array.prototype.map.call(
              body.querySelectorAll('[data-session-reviews] input[data-change-check]:checked'),
              function (input) {
                return input.dataset.changeCheck;
              },
            )
          : [];
        if (changeIds.length === 0) {
          showToast('Select at least one file to apply.', 'warn');
          return;
        }
        post({ type: 'approveChangeSet', sessionId: sessionId, ids: changeIds });
        break;
      }
      case 'reject-change':
        post({ type: 'rejectChangeSet', sessionId: sessionId });
        break;
      case 'approve-repair-selected': {
        var repairIds = body
          ? Array.prototype.map.call(
              body.querySelectorAll('[data-session-repairs] input[data-repair-check]:checked'),
              function (input) {
                return input.dataset.repairCheck;
              },
            )
          : [];
        if (repairIds.length === 0) {
          showToast('Select at least one repair change to apply.', 'warn');
          return;
        }
        post({ type: 'approveRepair', sessionId: sessionId, ids: repairIds });
        break;
      }
      case 'reject-repair':
        post({ type: 'rejectRepair', sessionId: sessionId });
        break;
      case 'run-validation': {
        var select = body ? body.querySelector('select[data-session-validation]') : null;
        var command = select ? select.value : '';
        if (!command) {
          showToast('Choose an allowlisted validation command first.', 'warn');
          return;
        }
        post({ type: 'validateSession', sessionId: sessionId, command: command });
        break;
      }
      case 'plan-repair':
        post({ type: 'generateRepair', sessionId: sessionId });
        break;
      case 'pause':
        post({ type: 'pauseSession', sessionId: sessionId });
        break;
      case 'resume':
        post({ type: 'resumeSession', sessionId: sessionId });
        break;
      case 'restore':
        post({ type: 'restoreSession', sessionId: sessionId });
        break;
      case 'cancel':
        post({ type: 'cancelSession', sessionId: sessionId });
        break;
      case 'undo':
        post({ type: 'undoSession', sessionId: sessionId });
        break;
      case 'delete':
        if (window.confirm('Delete this agent session and its stored record?')) {
          post({ type: 'deleteSession', sessionId: sessionId });
        }
        break;
      default:
        break;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          showToast('Copied to clipboard.', 'info');
        },
        function () {
          showToast('Could not copy to the clipboard.', 'warn');
        },
      );
      return;
    }
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    var copied = document.execCommand('copy');
    area.remove();
    showToast(
      copied ? 'Copied to clipboard.' : 'Could not copy to the clipboard.',
      copied ? 'info' : 'warn',
    );
  }

  window.addEventListener('message', function (event) {
    handleMessage(event.data);
  });

  els.send.addEventListener('click', submit);
  els.stop.addEventListener('click', function () {
    post({ type: 'stop' });
  });
  els.newChat.addEventListener('click', function () {
    post({ type: 'newChat' });
  });
  els.deleteConversation.addEventListener('click', function () {
    if (!state.activeConversationId) {
      return;
    }
    if (window.confirm('Delete this conversation? This cannot be undone.')) {
      post({ type: 'deleteConversation', id: state.activeConversationId });
    }
  });
  els.conversationSelect.addEventListener('change', function () {
    var id = els.conversationSelect.value;
    if (!id) {
      post({ type: 'newConversation' });
    } else if (id !== state.activeConversationId) {
      post({ type: 'switchConversation', id: id });
    }
  });
  els.sessionSelect.addEventListener('change', function () {
    var id = els.sessionSelect.value;
    if (!id) {
      state.activeSessionId = '';
      state.session = null;
      els.messages.querySelectorAll('[data-session-id]').forEach(function (node) {
        node.remove();
      });
      setEmpty(!hasMessages());
      return;
    }
    if (id !== state.activeSessionId) {
      post({ type: 'focusSession', sessionId: id });
    }
  });
  els.mode.addEventListener('change', updateModeUi);
  els.prompt.addEventListener('input', autoResize);
  els.prompt.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  els.statusPill.addEventListener('click', function () {
    const status = state.status;
    if (status && status.credentialRequired && !status.hasCredential) {
      post({ type: 'setApiKey' });
    } else {
      post({ type: 'openSettings' });
    }
  });

  els.attachmentBar.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-remove]');
    if (button) {
      post({ type: 'removeAttachment', id: button.dataset.remove });
    }
  });

  els.messages.addEventListener('change', function (event) {
    const input = event.target.closest('input[data-change-check], input[data-repair-check]');
    if (!input) {
      return;
    }
    const article = input.closest('[data-session-id]');
    const sessionId = article ? article.dataset.sessionId : '';
    if (!sessionId) {
      return;
    }
    if (input.hasAttribute('data-repair-check')) {
      const repairs = state.repairSelections[sessionId] || (state.repairSelections[sessionId] = {});
      repairs[input.dataset.repairCheck] = input.checked;
    } else {
      const changes = state.changeSelections[sessionId] || (state.changeSelections[sessionId] = {});
      changes[input.dataset.changeCheck] = input.checked;
    }
  });

  document.addEventListener('click', function (event) {
    const sessionButton = event.target.closest('button[data-session-action]');
    if (sessionButton) {
      handleSessionAction(sessionButton);
      return;
    }

    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }
    switch (button.dataset.action) {
      case 'copy-code': {
        const block = button.closest('.code-block');
        const code = block ? block.querySelector('code') : null;
        if (code) {
          copyText(code.textContent || '');
        }
        break;
      }
      case 'attach-selection':
        post({ type: 'attachSelection' });
        break;
      case 'attach-active':
        post({ type: 'attachActiveFile' });
        break;
      case 'attach-files':
        post({ type: 'attachFiles' });
        break;
      case 'attach-relevant':
        post({ type: 'attachRelevantFiles', query: els.prompt.value.trim() });
        break;
      case 'summarize-workspace':
        post({ type: 'summarizeWorkspace' });
        break;
      case 'refresh-sessions':
        post({ type: 'refreshSessions' });
        break;
      case 'clear-attachments':
        post({ type: 'clearAttachments' });
        break;
      case 'explain-selection':
        post({ type: 'explainSelection' });
        break;
      case 'set-key':
        post({ type: 'setApiKey' });
        break;
      case 'open-settings':
        post({ type: 'openSettings' });
        break;
      case 'show-log':
        post({ type: 'showLog' });
        break;
      default:
        break;
    }
  });

  renderStatus();
  renderWorkspace();
  renderConversationSelect();
  renderAttachmentBar();
  updateModeUi();
  setBusy(false);
  autoResize();
  post({ type: 'ready' });
})();
