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
    historyStatus: document.getElementById('history-status'),
    clearConversationButton: document.getElementById('clear-conversation'),
    restoreConversationButton: document.getElementById('restore-conversation'),
    contextStrip: document.getElementById('context-strip'),
    statusPill: document.getElementById('provider-status'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    version: document.getElementById('version'),
    workspaceName: document.getElementById('workspace-name'),
    privacyNote: document.getElementById('privacy-note'),
    attachmentBar: document.getElementById('attachment-bar'),
    clearAttachments: document.getElementById('clear-attachments'),
    contextBudget: document.getElementById('context-budget'),
    sessionSelect: document.getElementById('session-select'),
    toast: document.getElementById('toast'),
    providerSelectorRow: document.getElementById('provider-selector-row'),
    providerName: document.getElementById('provider-name'),
    modelName: document.getElementById('model-name'),
    providerClass: document.getElementById('provider-class'),
    switchProvider: document.getElementById('switch-provider'),
    switchModel: document.getElementById('switch-model'),
    setApiKeySelector: document.getElementById('set-api-key-selector'),
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
    history: null,
    request: null,
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
    // Automatically discovered content is labelled so it is never mistaken for
    // something the user attached on purpose.
    const suffix = attachment.origin === 'workspace' ? ' · auto' : '';
    if (attachment.isSelection && attachment.startLine) {
      const end = attachment.endLine || attachment.startLine;
      return attachment.path + ':' + attachment.startLine + '-' + end + suffix;
    }
    return attachment.path + suffix;
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
      '.quick-button, [data-action="attach-selection"], [data-action="attach-active"], [data-action="attach-files"], [data-action="attach-relevant"], [data-action="summarize-workspace"], [data-action="inspect-repository"], [data-action="inspect-git"], [data-action="explain-context"], [data-action="clear-attachments"], [data-action="clear-conversation"], [data-action="restore-conversation"]',
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
      els.providerSelectorRow.hidden = true;
      return;
    }

    if (status.configurationError) {
      els.statusPill.dataset.state = 'error';
      els.statusText.textContent = 'Provider needs configuration';
      els.statusPill.title = status.configurationError + '\nClick to open provider settings.';
      els.providerSelectorRow.hidden = true;
      return;
    }

    if (status.credentialRequired && !status.hasCredential) {
      els.statusPill.dataset.state = 'warn';
      els.statusText.textContent = 'API key required';
      els.statusPill.title = 'No API key is stored. Click to set one securely.';
      els.emptySetKey.hidden = false;
      els.providerSelectorRow.hidden = true;
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

    // Provider / model selector row
    els.providerSelectorRow.hidden = false;
    els.providerName.textContent = status.displayName;
    els.modelName.textContent = status.model;
    const accessCls = status.access || 'custom-unknown';
    els.providerClass.className = 'provider-class ' + accessCls;
    const classLabels = {
      'free-no-key': 'Free · no key',
      'free-tier-key': 'Free tier · key required',
      paid: 'Paid · key required',
      local: 'Local · self-hosted',
      'custom-unknown': 'Custom · pricing unknown',
    };
    els.providerClass.textContent = classLabels[accessCls] || 'Pricing unknown';
    els.setApiKeySelector.hidden = status.credentialRequired && !status.hasCredential;
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
      option.textContent =
        conversation.messageCount > 0
          ? conversation.title + ' (' + conversation.messageCount + ')'
          : 'New chat — current, empty';
      if (conversation.id === state.activeConversationId) {
        matched = true;
      }
      els.conversationSelect.append(option);
    });

    // Assigning the value after the rebuild avoids relying on implicit
    // first-option selection when no option carries the selected flag.
    els.conversationSelect.value = matched ? state.activeConversationId : '';
    els.deleteConversation.hidden = !state.activeConversationId;
    if (els.restoreConversationButton) {
      const others = list.filter(function (conversation) {
        return conversation.id !== state.activeConversationId && conversation.messageCount > 0;
      }).length;
      els.restoreConversationButton.disabled = others === 0;
      els.restoreConversationButton.title =
        others === 0
          ? 'No other stored conversation is available yet'
          : 'Open the conversation selected in the history list, or the most recently used one (' +
            others +
            ' available)';
    }
  }

  function renderHistory(warnings) {
    const history = state.history;
    if (!els.historyStatus) {
      return;
    }
    const list = Array.isArray(warnings) ? warnings : [];

    if (!history || history.conversationId === '') {
      els.historyStatus.textContent = 'History: not loaded';
      els.historyStatus.dataset.state = '';
      els.historyStatus.title = 'QuantsMind has not restored a conversation yet.';
      if (els.clearConversationButton) {
        els.clearConversationButton.hidden = true;
      }
      return;
    }

    const previous = history.messages;
    if (previous === 0 || history.restored !== true) {
      els.historyStatus.textContent = 'History: clean · starts with your next message';
      els.historyStatus.dataset.state = 'clean';
      els.historyStatus.title =
        'Nothing is replayed. The next request contains only the system instructions and your current message.';
    } else {
      const label =
        'History: ' +
        previous +
        ' previous message' +
        (previous === 1 ? '' : 's') +
        ' · ' +
        formatNumber(history.chars) +
        ' ch' +
        (history.attachmentTurns > 0
          ? ' · ' + history.attachmentTurns + ' with attachments'
          : '') +
        (history.unavailableAttachments > 0
          ? ' · ' + history.unavailableAttachments + ' attachment context unavailable'
          : '');
      els.historyStatus.textContent = label;
      els.historyStatus.dataset.state =
        history.unavailableAttachments > 0 || list.length > 0 ? 'warn' : 'restored';
      els.historyStatus.title =
        'These messages are replayed to the provider with every new request.' +
        (list.length > 0 ? '\n' + list.join('\n') : '');
    }

    if (els.clearConversationButton) {
      els.clearConversationButton.hidden = !(history.transcriptMessages > 0);
    }
  }

  function renderRequestContext(breakdown) {
    if (!els.contextStrip || !breakdown) {
      return;
    }
    els.contextStrip.hidden = false;
    els.contextStrip.textContent =
      'Sent: ' +
      breakdown.messages +
      ' msgs · system ' +
      formatNumber(breakdown.systemChars) +
      ' ch · history ' +
      breakdown.historyMessages +
      ' msgs ' +
      formatNumber(breakdown.historyChars) +
      ' ch · prompt ' +
      formatNumber(breakdown.promptChars) +
      ' ch · attachments ' +
      breakdown.attachmentItems +
      ' (' +
      formatNumber(breakdown.attachmentChars) +
      ' ch) · total ' +
      formatNumber(breakdown.totalChars) +
      ' ch';
    els.contextStrip.title =
      'Exactly what the last request contained. Detailed diagnostics are in the QuantsMind output log.';
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

  function appendStatusChips(container, details) {
    if (!details || details.length === 0) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'message-attachments';

    details.forEach(function (detail) {
      const chip = document.createElement('span');
      chip.className = 'chip static ctx-' + (detail.status || 'legacy');
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = detail.path || 'attachment';
      const meta = document.createElement('span');
      meta.className = 'chip-meta';
      meta.textContent =
        detail.status === 'captured'
          ? formatNumber(detail.chars) + ' ch captured'
          : detail.status === 'unavailable'
            ? 'context unavailable'
            : 'path only (older version)';
      chip.title =
        detail.status === 'captured'
          ? 'This turn replays the context captured when the request was sent (' +
            formatNumber(detail.chars) +
            ' chars).'
          : detail.status === 'unavailable'
            ? 'The captured context for this file is no longer stored, so it is not replayed. The file name remains in the transcript.'
            : 'This conversation was stored by an older version that kept only the file name, so its captured context cannot be replayed.';
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

  function appendUserMessage(text, attachments, labels, details) {
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
    if (details && details.length > 0) {
      appendStatusChips(article, details);
    } else {
      appendLabelChips(article, labels);
    }
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

  function appendAssistantHtml(html, heading) {
    const article = document.createElement('article');
    article.className = 'message assistant';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = heading || 'QuantsMind';

    const card = document.createElement('div');
    card.className = 'assistant-card';
    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = html;

    card.append(content);
    article.append(label, card);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);
  }

  function appendToolResult(message) {
    const article = document.createElement('article');
    article.className = 'message assistant';

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'Tool result';

    const card = document.createElement('div');
    card.className = 'assistant-card';

    const title = document.createElement('div');
    title.className = 'message-meta';
    title.textContent = (message.tool || 'tool') + ' - ' + (message.ok ? 'succeeded' : 'failed');

    const text = document.createElement('p');
    text.className = 'error-message';
    text.textContent = message.message || '';

    card.append(title, text);

    let parsed = null;
    if (typeof message.output === 'string' && message.output.trim().length > 0) {
      try {
        parsed = JSON.parse(message.output);
      } catch (error) {
        parsed = null;
      }
    }

    if (parsed && Array.isArray(parsed.files)) {
      parsed.files.forEach(function (file) {
        const fileCard = document.createElement('div');
        fileCard.className = 'assistant-card';
        fileCard.style.marginTop = '8px';

        const fileTitle = document.createElement('div');
        fileTitle.className = 'message-meta';
        fileTitle.textContent = (file.kind || 'change') + ': ' + (file.path || '');
        fileCard.append(fileTitle);

        if (typeof file.summary === 'string' && file.summary.length > 0) {
          const summary = document.createElement('p');
          summary.className = 'error-message';
          summary.textContent = file.summary;
          fileCard.append(summary);
        }

        if (typeof file.diff === 'string' && file.diff.length > 0) {
          const diff = document.createElement('pre');
          diff.className = 'message-content';
          diff.style.whiteSpace = 'pre-wrap';
          diff.style.maxHeight = '240px';
          diff.style.overflow = 'auto';
          const limited = file.diff.length > 8000 ? file.diff.slice(0, 8000) + '\\n...[truncated]' : file.diff;
          diff.textContent = limited;
          fileCard.append(diff);
        }

        card.append(fileCard);
      });
    } else if (parsed && typeof parsed.command === 'string') {
      const command = document.createElement('div');
      command.className = 'message-meta';
      command.textContent = 'Command: ' + parsed.command + ' (exit ' + (parsed.exitCode === null ? 'unknown' : parsed.exitCode) + ')';
      card.append(command);

      if (typeof parsed.output === 'string' && parsed.output.trim().length > 0) {
        const output = document.createElement('pre');
        output.className = 'message-content';
        output.style.whiteSpace = 'pre-wrap';
        output.style.maxHeight = '240px';
        output.style.overflow = 'auto';
        const limited = parsed.output.length > 8000 ? parsed.output.slice(0, 8000) + '\\n...[truncated]' : parsed.output;
        output.textContent = limited;
        card.append(output);
      }
    } else if (typeof message.output === 'string' && message.output.trim().length > 0) {
      const output = document.createElement('pre');
      output.className = 'message-content';
      output.style.whiteSpace = 'pre-wrap';
      output.style.maxHeight = '240px';
      output.style.overflow = 'auto';
      const limited = message.output.length > 12000 ? message.output.slice(0, 12000) + '\\n...[truncated]' : message.output;
      output.textContent = limited;
      card.append(output);
    }

    article.append(label, card);
    els.messages.append(article);
    setEmpty(false);
    scrollToBottom(true);
  }

  function createAssistantMessage(model) {    const article = document.createElement('article');
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

  var VALIDATION_OUTCOME_LABELS = {
    passed: 'passed',
    failed: 'failed',
    skipped: 'skipped',
    unavailable: 'no check available',
  };

  /** Every action that answers a pending ApprovalRequest; each needs its id. */
  var APPROVAL_ACTIONS = {
    'approve-plan': true,
    'reject-plan': true,
    'approve-change-selected': true,
    'reject-change': true,
    'approve-repair-selected': true,
    'reject-repair': true,
    'approve-validation': true,
    'reject-validation': true,
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
        var evidence = run.evidence;
        var outcome =
          run.outcome || (evidence ? (evidence.passed ? 'passed' : 'failed') : 'unavailable');
        var tone = outcome === 'passed' ? 'ok' : outcome === 'failed' ? 'bad' : 'muted';
        var outcomeLabel = VALIDATION_OUTCOME_LABELS[outcome] || outcome;
        if (!evidence) {
          return (
            '<div class="validation ' + tone + '">' +
            '<div class="validation-head"><span class="validation-command">' +
            escapeHtml(run.command || outcomeLabel) + '</span>' +
            '<span class="validation-state">' + escapeHtml(outcomeLabel) + '</span></div>' +
            '<p class="validation-detail">' +
            escapeHtml(run.detail || 'No command was executed.') + '</p>' +
            '</div>'
          );
        }
        var stateLabel = evidence.cancelled
          ? 'cancelled'
          : evidence.timedOut
            ? 'timed out'
            : 'exit ' + (evidence.exitCode === null || evidence.exitCode === undefined ? 'unknown' : evidence.exitCode);
        var binding = run.changeSetId
          ? 'Tested change set ' +
            run.changeSetId +
            (run.repairProposalId ? ' after repair ' + run.repairProposalId : '')
          : '';
        return (
          '<div class="validation ' + tone + '">' +
          '<div class="validation-head"><span class="validation-command">' + escapeHtml(evidence.command || run.command) + '</span>' +
          '<span class="validation-state">' + escapeHtml(stateLabel) + ' · ' + formatNumber(evidence.durationMs) + ' ms</span></div>' +
          '<pre class="command-output">' + escapeHtml(evidence.output || '(no output)') + '</pre>' +
          (binding ? '<p class="validation-detail">' + escapeHtml(binding) + '</p>' : '') +
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

  function confidenceLabel(value) {
    return value === 'confirmed' ? 'confirmed' : 'heuristic';
  }

  function renderImpact(changeSet) {
    var impact = changeSet && changeSet.impact;
    if (!impact || typeof impact !== 'object') {
      return '';
    }
    var directFiles = impact.directFiles || [];
    var indirectFiles = impact.indirectFiles || [];
    var regressionAreas = impact.regressionAreas || [];
    var recommendedTests = impact.recommendedTests || [];
    var validationCommands = impact.validationCommands || [];
    var evidence = impact.evidence || [];
    var filesHtml = directFiles
      .slice(0, 12)
      .map(function (file) {
        return (
          '<li><code>' + escapeHtml(file.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(file.relationship) + ' · ' + escapeHtml(confidenceLabel(file.confidence)) + '</span></li>'
        );
      })
      .join('');
    var affectedHtml = indirectFiles
      .slice(0, 12)
      .map(function (file) {
        return (
          '<li><code>' + escapeHtml(file.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(file.relationship) + ' · depth ' + Number(file.distance || 0) + ' · ' + escapeHtml(confidenceLabel(file.confidence)) + '</span>' +
          (file.reason ? '<span class="impact-reason">' + escapeHtml(file.reason) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    var testsHtml = recommendedTests
      .slice(0, 8)
      .map(function (test) {
        return (
          '<li><code>' + escapeHtml(test.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(confidenceLabel(test.confidence)) + '</span>' +
          (test.reason ? '<span class="impact-reason">' + escapeHtml(test.reason) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    var areasHtml = regressionAreas
      .slice(0, 8)
      .map(function (area) {
        return (
          '<li><code>' + escapeHtml(area.path) + '</code>' +
          '<span class="impact-risk risk-' + escapeHtml(area.risk) + '">' + escapeHtml(area.risk) + '</span>' +
          (area.reason ? '<span class="impact-reason">' + escapeHtml(area.reason) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    var commandsHtml = validationCommands
      .slice(0, 8)
      .map(function (item) {
        return (
          '<li><code>' + escapeHtml(item.command) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(item.source) + ' · ' + escapeHtml(confidenceLabel(item.confidence)) + '</span></li>'
        );
      })
      .join('');
    var evidenceHtml = evidence
      .slice(0, 8)
      .map(function (item) {
        return '<li>' + escapeHtml(item) + '</li>';
      })
      .join('');
    return (
      '<div class="impact-card">' +
      '<div class="impact-head"><span class="section-label">Change impact</span>' +
      '<span class="impact-confidence confidence-' + escapeHtml(impact.confidence) + '">' + escapeHtml(impact.confidence) + ' confidence</span></div>' +
      '<p class="impact-summary">' + Number(directFiles.length) + ' direct · ' + Number(indirectFiles.length) + ' affected · ' + Number(recommendedTests.length) + ' recommended test(s)' +
      (impact.limits && impact.limits.truncated ? ' · analysis truncated' : '') + '</p>' +
      (filesHtml ? '<div class="impact-section"><span class="impact-label">Changed files</span><ul class="impact-list">' + filesHtml + '</ul></div>' : '') +
      (affectedHtml ? '<div class="impact-section"><span class="impact-label">Affected files</span><ul class="impact-list">' + affectedHtml + '</ul></div>' : '') +
      (areasHtml ? '<div class="impact-section"><span class="impact-label">Regression areas</span><ul class="impact-list">' + areasHtml + '</ul></div>' : '') +
      (testsHtml ? '<div class="impact-section"><span class="impact-label">Recommended tests</span><ul class="impact-list">' + testsHtml + '</ul></div>' : '') +
      (commandsHtml ? '<div class="impact-section"><span class="impact-label">Suggested validation</span><ul class="impact-list">' + commandsHtml + '</ul></div>' : '') +
      (evidenceHtml ? '<div class="impact-section"><span class="impact-label">Evidence</span><ul class="impact-list impact-evidence">' + evidenceHtml + '</ul></div>' : '') +
      '</div>'
    );
  }

  function renderArchitectureHtml(architecture) {
    if (!architecture || typeof architecture !== 'object') {
      return '';
    }
    var layers = (architecture.layers || [])
      .map(function (layer) {
        return '<li><code>' + escapeHtml(layer.layer) + '</code>' +
          '<span class="impact-meta">' + Number(layer.components || 0) + ' component(s), ' + Number(layer.files || 0) + ' file(s)</span></li>';
      })
      .join('');
    var components = (architecture.components || [])
      .slice(0, 20)
      .map(function (component) {
        return '<li><code>' + escapeHtml(component.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(component.name) + ' · ' + escapeHtml(component.layer) + ' · ' +
          (component.roles || []).map(escapeHtml).join(', ') + ' · ' + escapeHtml(confidenceLabel(component.confidence)) + '</span>' +
          (component.evidence && component.evidence.length
            ? '<span class="impact-reason">' + component.evidence.map(escapeHtml).join(' · ') + '</span>'
            : '') +
          '</li>';
      })
      .join('');
    var relationships = (architecture.relationships || [])
      .slice(0, 20)
      .map(function (relationship) {
        return '<li><code>' + escapeHtml(relationship.from) + '</code> → <code>' + escapeHtml(relationship.to) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(relationship.kind) + ' · ' + escapeHtml(confidenceLabel(relationship.confidence)) + '</span></li>';
      })
      .join('');
    var frameworks = (architecture.frameworks || [])
      .map(function (framework) {
        return '<li><code>' + escapeHtml(framework.name) + '</code><span class="impact-meta">' + escapeHtml(framework.layer) + '</span></li>';
      })
      .join('');
    return (
      '<div class="impact-section"><span class="impact-label">Architecture</span>' +
      '<pre class="repository-summary">' + escapeHtml(architecture.summaryText || '') + '</pre>' +
      (layers ? '<div class="impact-subsection">Layers</div><ul class="impact-list">' + layers + '</ul>' : '') +
      (frameworks ? '<div class="impact-subsection">Frameworks by layer</div><ul class="impact-list">' + frameworks + '</ul>' : '') +
      (components ? '<div class="impact-subsection">Components</div><ul class="impact-list">' + components + '</ul>' : '') +
      (relationships ? '<div class="impact-subsection">Relationships</div><ul class="impact-list">' + relationships + '</ul>' : '') +
      '</div>'
    );
  }

  function renderKarkainHtml(karkain) {
    if (!karkain || typeof karkain !== 'object') {
      return '';
    }
    var summary = karkain.summary || {};
    var graph = karkain.graph || {};
    var types = (summary.types || [])
      .map(function (type) {
        return '<li><code>' + escapeHtml(type.name) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(type.kind) + ' · ' + escapeHtml(type.path) + '</span></li>';
      })
      .join('');
    var modules = (graph.modules || [])
      .map(function (module) {
        return '<li><code>' + escapeHtml(module.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(module.name) + ' · ' + (module.symbols || []).length + ' symbol(s) · imports ' +
          (module.dependencies || []).map(escapeHtml).join(', ') + '</span></li>';
      })
      .join('');
    var edges = (graph.edges || [])
      .slice(0, 30)
      .map(function (edge) {
        return '<li><code>' + escapeHtml(edge.fromPath) + '</code> → <code>' + escapeHtml(edge.toPath) + '</code>' +
          '<span class="impact-meta">line ' + Number(edge.line || 0) + '</span></li>';
      })
      .join('');
    var cycles = (graph.cycles || [])
      .map(function (cycle) {
        return '<li>' + cycle.map(function (node) { return '<code>' + escapeHtml(node) + '</code>'; }).join(' → ') + '</li>';
      })
      .join('');
    var unresolved = (graph.unresolved || [])
      .map(function (item) {
        return '<li><code>' + escapeHtml(item.fromPath) + '</code> → <code>' + escapeHtml(item.name) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(item.reason) + '</span></li>';
      })
      .join('');
    return (
      '<div class="impact-section"><span class="impact-label">Karkain project</span>' +
      '<pre class="repository-summary">' + escapeHtml(summary.summaryText || '') + '</pre>' +
      (types ? '<div class="impact-subsection">Types</div><ul class="impact-list">' + types + '</ul>' : '') +
      (modules ? '<div class="impact-subsection">Modules</div><ul class="impact-list">' + modules + '</ul>' : '') +
      (edges ? '<div class="impact-subsection">Module imports</div><ul class="impact-list">' + edges + '</ul>' : '') +
      (cycles ? '<div class="impact-subsection">Cycles</div><ul class="impact-list">' + cycles + '</ul>' : '') +
      (unresolved ? '<div class="impact-subsection">Unresolved imports</div><ul class="impact-list">' + unresolved + '</ul>' : '') +
      '</div>'
    );
  }

  function renderRepositoryHtml(repository) {
    if (!repository || typeof repository !== 'object' || !repository.overview) {
      return '<div class="text">No repository data is available.</div>';
    }
    var overview = repository.overview;
    var deps = repository.dependencies || {};
    var languages = (overview.languages || [])
      .slice(0, 10)
      .map(function (language) {
        return escapeHtml(language.name) + ' (' + Number(language.files || 0) + ')';
      })
      .join(', ');
    var technologies = (overview.technologies || [])
      .slice(0, 12)
      .map(function (technology) {
        return escapeHtml(technology.name) + ' [' + escapeHtml(confidenceLabel(technology.confidence)) + ']';
      })
      .join(', ');
    var buildSystems = (overview.buildSystems || [])
      .map(function (system) {
        return escapeHtml(system.name) + (system.commands && system.commands.length ? ' (' + system.commands.slice(0, 3).map(escapeHtml).join(', ') + ')' : '');
      })
      .join(', ');
    var entryPoints = (overview.entryPoints || []).slice(0, 10).map(escapeHtml).join(', ');
    var configFiles = (overview.configFiles || []).slice(0, 10).map(escapeHtml).join(', ');
    var monorepo = overview.monorepo || null;
    var monorepoText = monorepo
      ? (monorepo.isMonorepo
          ? 'Yes — ' + (monorepo.packages || []).slice(0, 6).map(escapeHtml).join(', ') +
            (monorepo.workspaces && monorepo.workspaces.length ? ' (workspaces: ' + monorepo.workspaces.slice(0, 4).map(escapeHtml).join(', ') + ')' : '') +
            ' [' + escapeHtml(confidenceLabel(monorepo.confidence)) + ']'
          : 'No')
      : '';
    var hotspots = (deps.hotspots || [])
      .slice(0, 10)
      .map(function (spot) {
        return (
          '<li><code>' + escapeHtml(spot.path) + '</code>' +
          '<span class="impact-meta">' + Number(spot.dependents || 0) + ' dependent(s) · ' + Number(spot.dependencies || 0) + ' dependency(ies)' +
          (spot.publicApi ? ' · public API' : '') + '</span></li>'
        );
      })
      .join('');
    var cycles = (deps.cycles || [])
      .slice(0, 6)
      .map(function (cycle) {
        return '<li>' + cycle.map(function (path) { return '<code>' + escapeHtml(path) + '</code>'; }).join(' → ') + '</li>';
      })
      .join('');
    var unresolved = (deps.unresolved || [])
      .slice(0, 10)
      .map(function (reference) {
        return '<li><code>' + escapeHtml(reference.from) + '</code> → <code>' + escapeHtml(reference.specifier) + '</code><span class="impact-meta">' + escapeHtml(reference.reason) + ' · ' + escapeHtml(confidenceLabel(reference.confidence)) + '</span></li>';
      })
      .join('');
    return (
      '<div class="repository-card">' +
      '<div class="impact-head"><span class="section-label">Repository overview</span>' +
      '<span class="impact-confidence">local analysis</span></div>' +
      '<pre class="repository-summary">' + escapeHtml(repository.summary || '') + '</pre>' +
      '<div class="impact-section"><span class="impact-label">Structure</span>' +
      '<p>' + Number(overview.fileCount || 0) + ' file(s), ' + Number(overview.sourceFileCount || 0) + ' source, ' + Number(overview.testFileCount || 0) + ' test.</p>' +
      (languages ? '<p><strong>Languages:</strong> ' + languages + '</p>' : '') +
      (technologies ? '<p><strong>Technologies:</strong> ' + technologies + '</p>' : '') +
      (buildSystems ? '<p><strong>Build/test:</strong> ' + buildSystems + '</p>' : '') +
      (entryPoints ? '<p><strong>Entry points:</strong> ' + entryPoints + '</p>' : '') +
      (configFiles ? '<p><strong>Config:</strong> ' + configFiles + '</p>' : '') +
      (monorepoText ? '<p><strong>Monorepo:</strong> ' + monorepoText + '</p>' : '') +
      '</div>' +
      '<div class="impact-section"><span class="impact-label">Dependencies</span>' +
      '<p>' + Number(deps.nodeCount || 0) + ' node(s), ' + Number(deps.edgeCount || 0) + ' edge(s), ' + Number(deps.heuristicEdges || 0) + ' heuristic, ' + Number(deps.unresolvedCount || 0) + ' unresolved, ' + Number(deps.cycleCount || 0) + ' cycle(s)' + (deps.truncated ? ' · truncated' : '') + '.</p>' +
      (hotspots ? '<ul class="impact-list">' + hotspots + '</ul>' : '') +
      '</div>' +
      (cycles ? '<div class="impact-section"><span class="impact-label">Cycles</span><ul class="impact-list">' + cycles + '</ul></div>' : '') +
      (unresolved ? '<div class="impact-section"><span class="impact-label">Unresolved local references</span><ul class="impact-list">' + unresolved + '</ul></div>' : '') +
      renderArchitectureHtml(repository.architecture) +
      renderKarkainHtml(repository.karkain) +
      '</div>'
    );
  }

  var executionNodes = {};

  function executionStatusLabel(status) {
    switch (status) {
      case 'succeeded': return 'Passed';
      case 'failed': return 'Failed';
      case 'cancelled': return 'Cancelled';
      case 'timed-out': return 'Timed out';
      default: return 'Running';
    }
  }

  function executionBadgeClass(status) {
    switch (status) {
      case 'succeeded': return 'execution-badge execution-ok';
      case 'failed': return 'execution-badge execution-bad';
      case 'cancelled': return 'execution-badge execution-warn';
      case 'timed-out': return 'execution-badge execution-warn';
      default: return 'execution-badge execution-run';
    }
  }

  function cardBody(execution) {
    var status = execution.state === 'running' && !execution.status ? 'running' : (execution.status || 'running');
    var parts = [];
    parts.push('<div class="execution-head">');
    parts.push('<span class="section-label">Execution · ' + escapeHtml(execution.kind || 'command') + '</span>');
    parts.push('<span class="' + escapeHtml(executionBadgeClass(status)) + '">' + escapeHtml(executionStatusLabel(status)) + '</span>');
    parts.push('</div>');
    parts.push('<p class="execution-command"><code>' + escapeHtml(execution.command || '') + '</code></p>');
    var metaBits = ['<span class="impact-meta">' + escapeHtml(execution.cwd || '')];
    if (execution.durationMs !== undefined) {
      metaBits.push(' · ' + Number(execution.durationMs) + ' ms');
    }
    if (execution.exitCode !== null && execution.exitCode !== undefined) {
      metaBits.push(' · exit ' + Number(execution.exitCode));
    }
    metaBits.push('</span>');
    parts.push(metaBits.join(''));
    if (execution.tests) {
      var t = execution.tests;
      var bits = [];
      if (t.passed !== undefined) { bits.push(Number(t.passed) + ' passed'); }
      if (t.failed !== undefined) { bits.push(Number(t.failed) + ' failed'); }
      if (t.skipped !== undefined) { bits.push(Number(t.skipped) + ' skipped'); }
      if (t.total !== undefined) { bits.push('of ' + Number(t.total)); }
      if (bits.length) {
        parts.push('<p class="impact-meta">Tests: ' + escapeHtml(bits.join(', ')) + '</p>');
      }
    }
    if (execution.diagnostics !== undefined) {
      parts.push('<p class="impact-meta">' + Number(execution.diagnostics) + ' diagnostic(s) reported</p>');
    }
    if (execution.output) {
      var truncated = execution.output.length > 4000 ? execution.output.slice(execution.output.length - 4000) : execution.output;
      parts.push('<pre class="execution-output">' + escapeHtml(truncated) + '</pre>');
      if (execution.truncated) {
        parts.push('<p class="change-warning">Output was truncated at the configured limit.</p>');
      }
      if (execution.timedOut) {
        parts.push('<p class="change-warning">The command timed out and was terminated.</p>');
      }
      if (execution.cancelled) {
        parts.push('<p class="change-warning">The command was cancelled.</p>');
      }
    }
    return parts.join('');
  }

  function upsertExecutionCard(execution) {
    var key = execution.id || 'execution';
    var existing = executionNodes[key];
    if (existing) {
      existing.innerHTML = cardBody(execution);
      return;
    }
    var article = document.createElement('article');
    article.className = 'message assistant';
    var label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'Execution';
    var card = document.createElement('div');
    card.className = 'assistant-card execution-card';
    var content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = cardBody(execution);
    card.append(content);
    article.append(label, card);
    els.messages.append(article);
    executionNodes[key] = content;
    setEmpty(false);
    scrollToBottom(true);
  }

  function renderGitStatusHtml(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return '<div class="text">No Git data is available.</div>';
    }
    var statusParts = [];
    function entryRow(entry) {
      var badge = entry.state === 'untracked' ? '?' : entry.state.charAt(0).toUpperCase();
      return '<li><code>' + escapeHtml(entry.path) + '</code><span class="impact-meta">' + escapeHtml(entry.state) + '</span></li>';
    }
    var entries = (snapshot.entries || []).slice(0, 40).map(entryRow).join('');
    var log = (snapshot.log || [])
      .map(function (entry) {
        return '<li><code>' + escapeHtml(entry.shortSha) + '</code> ' + escapeHtml(entry.subject) + '<span class="impact-meta">' + escapeHtml(entry.author) + ' · ' + escapeHtml(String(entry.date || '').slice(0, 10)) + '</span></li>';
      })
      .join('');
    var checkpoints = (snapshot.checkpoints || [])
      .map(function (checkpoint) {
        return '<li><code>' + escapeHtml(checkpoint.id) + '</code><span class="impact-meta">' + Number(checkpoint.fileCount || 0) + ' file(s) · ' + escapeHtml(checkpoint.taskId) + (checkpoint.label ? ' · ' + escapeHtml(checkpoint.label) : '') + '</span></li>';
      })
      .join('');
    var githubLine = '';
    if (snapshot.github) {
      githubLine = '<p><strong>GitHub:</strong> ' + Number(snapshot.github.openIssues || 0) + ' open issue(s) · ' + Number(snapshot.github.openPullRequests || 0) + ' open PR(s)' + (snapshot.github.connected ? '' : ' (counts unavailable)') + '</p>';
    }
    var stateFlags = [];
    if (snapshot.mergeInProgress) { stateFlags.push('merge in progress'); }
    if (snapshot.rebaseInProgress) { stateFlags.push('rebase in progress'); }
    if (snapshot.conflicts > 0) { stateFlags.push(Number(snapshot.conflicts) + ' conflict(s)'); }
    var statusText = snapshot.clean ? 'Clean working tree' : (Number(snapshot.staged || 0) + ' staged · ' + Number(snapshot.modified || 0) + ' modified · ' + Number(snapshot.untracked || 0) + ' untracked · ' + Number(snapshot.deleted || 0) + ' deleted');
    return (
      '<div class="repository-card">' +
      '<div class="impact-head"><span class="section-label">Git status</span>' +
      '<span class="impact-confidence">local analysis</span></div>' +
      '<div class="impact-section"><span class="impact-label">Repository</span>' +
      '<p><strong>Branch:</strong> ' + escapeHtml(snapshot.branch || '') + (snapshot.headShort ? ' (' + escapeHtml(snapshot.headShort) + ')' : '') + '</p>' +
      (snapshot.root ? '<p><strong>Root:</strong> <code>' + escapeHtml(snapshot.root) + '</code></p>' : '') +
      (snapshot.remote ? '<p><strong>Remote:</strong> ' + escapeHtml(snapshot.remote) + '</p>' : '') +
      '<p>' + escapeHtml(statusText) + '</p>' +
      (stateFlags.length ? '<p class="change-warning">' + escapeHtml(stateFlags.join(' · ')) + '</p>' : '') +
      githubLine +
      '</div>' +
      (entries ? '<div class="impact-section"><span class="impact-label">Changes</span><ul class="impact-list">' + entries + '</ul></div>' : '') +
      (log ? '<div class="impact-section"><span class="impact-label">Recent commits</span><ul class="impact-list">' + log + '</ul></div>' : '') +
      (checkpoints ? '<div class="impact-section"><span class="impact-label">Checkpoints</span><ul class="impact-list">' + checkpoints + '</ul></div>' : '') +
      '</div>'
    );
  }

  function renderContextSelectionHtml(message) {
    var selections = message.selections || [];
    var rows = selections
      .map(function (selection) {
        return (
          '<li><code>' + escapeHtml(selection.path) + '</code>' +
          '<span class="impact-meta">' + escapeHtml(selection.relationship) + ' · score ' + Number(selection.score || 0) + ' · ' + escapeHtml(confidenceLabel(selection.confidence)) + '</span>' +
          (selection.reason ? '<span class="impact-reason">' + escapeHtml(selection.reason) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    return (
      '<div class="repository-card">' +
      '<div class="impact-head"><span class="section-label">Context selection</span>' +
      '<span class="impact-confidence">local only</span></div>' +
      '<p>Query: <code>' + escapeHtml(message.query || '') + '</code></p>' +
      (rows ? '<ul class="impact-list">' + rows + '</ul>' : '<p>No files were selected.</p>') +
      (message.truncated ? '<p class="change-warning">The selection was truncated by its file or character budget.</p>' : '') +
      '</div>'
    );
  }

  function renderSessionApproval(session) {
    var approval = session.pendingApproval;
    if (!approval) {
      return '';
    }
    var sessionId = escapeHtml(session.id);
    var requestId = escapeHtml(approval.id || '');
    if (approval.kind === 'plan') {
      return (
        '<div class="approval-card">' +
        '<div class="approval-head"><span class="approval-kind">Plan approval</span>' +
        '<span class="approval-title">' + escapeHtml(approval.title) + '</span></div>' +
        (approval.detail ? '<p class="approval-detail">' + escapeHtml(approval.detail) + '</p>' : '') +
        '<p class="task-notes">No files will be written until you approve the plan and then approve individual changes.</p>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-plan" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Approve plan</button>' +
        '<button type="button" class="action-button" data-session-action="reject-plan" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Reject plan</button>' +
        '</div></div>'
      );
    }

    if (approval.kind === 'validation-command') {
      return (
        '<div class="approval-card">' +
        '<div class="approval-head"><span class="approval-kind">Validation approval</span>' +
        '<span class="approval-title">' + escapeHtml(approval.title) + '</span></div>' +
        (approval.detail
          ? '<pre class="approval-detail">' +
            escapeHtml(approval.detail).split('\n').join('<br>') +
            '</pre>'
          : '') +
        '<p class="task-notes">Nothing runs until you approve this exact command in this directory. Rejecting it records a skipped check and keeps the session awaiting validation.</p>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-validation" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Run approved command</button>' +
        '<button type="button" class="action-button" data-session-action="reject-validation" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Do not run</button>' +
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
        renderImpact(changeSet) +
        '<p class="task-notes">Select the files to apply. Backups are created for every applied file.</p>' +
        '<div class="review-list" data-session-reviews="' + sessionId + '">' + reviews + '</div>' +
        '<div class="task-actions">' +
        '<button type="button" class="action-button primary" data-session-action="approve-change-selected" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Apply selected files</button>' +
        '<button type="button" class="action-button" data-session-action="reject-change" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Reject change set</button>' +
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
        '<button type="button" class="action-button primary" data-session-action="approve-repair-selected" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Apply repair</button>' +
        '<button type="button" class="action-button" data-session-action="reject-repair" data-session-id="' + sessionId + '" data-request-id="' + requestId + '">Reject repair</button>' +
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
    var suggested = (session.validationSuggestions || []).filter(function (command) {
      return typeof command === 'string' && command.length > 0;
    });
    var commands = suggested.length > 0 ? suggested : state.validationCommands;
    if (session.state === 'validating' && commands.length > 0 && !session.pendingApproval) {
      var progress = session.progress || {};
      var activeTask = (session.tasks || []).find(function (task) {
        return task.id === progress.activeTaskId;
      });
      var preferred = activeTask && activeTask.validationCommand ? activeTask.validationCommand : '';
      var options = commands
        .map(function (command) {
          return (
            '<option value="' + escapeHtml(command) + '"' + (command === preferred ? ' selected' : '') + '>' +
            escapeHtml(command) +
            '</option>'
          );
        })
        .join('');
      actions +=
        '<span class="validation-picker">' +
        '<select data-session-validation aria-label="Validation command" title="' +
        escapeHtml(suggested.length > 0 ? 'Derived from this project\'s scripts and the command allowlist' : 'Allowlisted validation commands') +
        '">' + options + '</select>' +
        '<button type="button" class="action-button primary" data-session-action="run-validation" data-session-id="' +
        sessionId +
        '">Request validation</button>' +
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
          renderImpact(changeSet) +
          '<div class="review-list">' + reviews + '</div></div>'
        );
      })
      .join('');

    var progress = session.progress;
    var activity =
      progress && progress.activity
        ? progress.activity +
          (progress.totalTasks > 0
            ? ' · ' + Number(progress.completedTasks || 0) + '/' + progress.totalTasks + ' task(s)'
            : '') +
          (progress.validation ? ' · validation: ' + progress.validation : '')
        : '';

    var html =
      '<div class="task-card session-card state-' + escapeHtml(session.state) + '">' +
      '<div class="task-head">' +
      '<span class="task-status">Session · ' + escapeHtml(SESSION_STATE_LABELS[session.state] || session.state) + '</span>' +
      '<span class="task-meta">' + escapeHtml(meta) + '</span>' +
      '</div>' +
      (activity ? '<p class="session-activity">' + escapeHtml(activity) + '</p>' : '') +
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
      option.title = session.activity
        ? session.activity + (session.validation ? ' · validation: ' + session.validation : '')
        : option.textContent;
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
        appendUserMessage(
          message.text || '',
          [],
          message.attachments || [],
          message.attachmentDetails || [],
        );
      } else if (message.role === 'assistant') {
        appendAssistantStatic(
          message.text || '',
          message.localOnly === true ? 'QuantsMind · local only' : undefined,
        );
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
    state.request = null;
    state.history = null;
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
    renderHistory();
    if (els.contextStrip) {
      els.contextStrip.hidden = true;
      els.contextStrip.textContent = '';
    }
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
        state.history = message.history || null;
        state.request = null;
        if (message.version) {
          document.title = 'QuantsMind AI Coder ' + message.version;
          if (els.version) {
            els.version.textContent = 'v' + message.version;
          }
        }
        renderStatus();
        renderWorkspace();
        renderConversationSelect();
        renderHistory();
        if (els.contextStrip) {
          els.contextStrip.hidden = true;
          els.contextStrip.textContent = '';
        }
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
      case 'history': {
        state.history = message.history || null;
        renderHistory(message.warnings || []);
        break;
      }
      case 'requestContext': {
        state.request = message.breakdown || null;
        renderRequestContext(message.breakdown || null);
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
      case 'agentToolResult': {
        appendToolResult(message);
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
        if (message.history) {
          state.history = message.history;
        }
        state.request = null;
        renderConversationSelect();
        renderHistory();
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
      case 'repository': {
        appendAssistantHtml(renderRepositoryHtml(message.repository), 'Repository intelligence');
        showToast('Repository inspected locally. Nothing was sent to the provider.', 'info');
        break;
      }
      case 'gitSnapshot': {
        appendAssistantHtml(renderGitStatusHtml(message.snapshot), 'Git status');
        break;
      }
      case 'contextSelection': {
        appendAssistantHtml(renderContextSelectionHtml(message), 'Context selection');
        showToast('Context selection explained locally. Nothing was sent to the provider.', 'info');
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
      case 'execution': {
        upsertExecutionCard(message.execution || {});
        break;
      }
      case 'executionHistory': {
        var history = Array.isArray(message.executions) ? message.executions : [];
        for (var i = 0; i < history.length; i += 1) {
          upsertExecutionCard(history[i]);
        }
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
    var requestId = button.dataset.requestId;
    if (APPROVAL_ACTIONS[action] === true && !requestId) {
      showToast('This approval card is out of date. Reopen the session to review the current request.', 'warn');
      return;
    }

    switch (action) {
      case 'approve-plan':
        post({ type: 'approvePlan', sessionId: sessionId, requestId: requestId });
        break;
      case 'reject-plan':
        post({ type: 'rejectPlan', sessionId: sessionId, requestId: requestId });
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
        post({ type: 'approveChangeSet', sessionId: sessionId, ids: changeIds, requestId: requestId });
        break;
      }
      case 'reject-change':
        post({ type: 'rejectChangeSet', sessionId: sessionId, requestId: requestId });
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
        post({ type: 'approveRepair', sessionId: sessionId, ids: repairIds, requestId: requestId });
        break;
      }
      case 'reject-repair':
        post({ type: 'rejectRepair', sessionId: sessionId, requestId: requestId });
        break;
      case 'approve-validation':
        post({ type: 'approveValidation', sessionId: sessionId, requestId: requestId });
        break;
      case 'reject-validation':
        post({ type: 'rejectValidation', sessionId: sessionId, requestId: requestId });
        break;
      case 'run-validation': {
        var select = body ? body.querySelector('select[data-session-validation]') : null;
        var command = select ? select.value : '';
        if (!command) {
          showToast('Choose an allowlisted validation command first.', 'warn');
          return;
        }
        post({ type: 'requestValidation', sessionId: sessionId, command: command });
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

  els.switchProvider.addEventListener('click', function () {
    post({ type: 'selectProvider' });
  });
  els.switchModel.addEventListener('click', function () {
    post({ type: 'selectModel' });
  });
  els.setApiKeySelector.addEventListener('click', function () {
    post({ type: 'setApiKey' });
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
      case 'inspect-repository':
        post({ type: 'inspectRepository' });
        break;
      case 'inspect-git':
        post({ type: 'inspectGitStatus' });
        break;
      case 'explain-context':
        post({ type: 'explainRepositoryContext', query: els.prompt.value.trim() });
        break;
      case 'refresh-sessions':
        post({ type: 'refreshSessions' });
        break;
      case 'clear-attachments':
        post({ type: 'clearAttachments' });
        break;
      case 'clear-conversation':
        post({ type: 'clearConversation' });
        break;
      case 'restore-conversation': {
        var selected = els.conversationSelect.value;
        var entry = (state.conversations || []).find(function (conversation) {
          return conversation.id === selected;
        });
        if (entry && entry.messageCount > 0) {
          post({ type: 'restorePreviousConversation', id: selected });
        } else {
          post({ type: 'restorePreviousConversation' });
        }
        break;
      }
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
  renderHistory();
  renderAttachmentBar();
  updateModeUi();
  setBusy(false);
  autoResize();
  post({ type: 'ready' });
})();
