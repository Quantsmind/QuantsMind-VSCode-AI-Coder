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
    statusPill: document.getElementById('provider-status'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    attachmentBar: document.getElementById('attachment-bar'),
    clearAttachments: document.getElementById('clear-attachments'),
    contextBudget: document.getElementById('context-budget'),
    toast: document.getElementById('toast'),
  };

  const state = {
    busy: false,
    attachments: [],
    status: null,
    maxPromptChars: 20000,
    streaming: null,
    pendingPrompt: null,
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
        '<pre class="code"><code class="language-' +
        escapeHtml(language) +
        '">' +
        escapeHtml(code) +
        '</code></pre>';
      lastIndex = fence.lastIndex;
    }

    if (lastIndex < source.length) {
      html += '<div class="text">' + renderInline(source.slice(lastIndex)) + '</div>';
    }

    return html || '<div class="text"></div>';
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
    const buttons = document.querySelectorAll(
      '.quick-button, [data-action="attach-selection"], [data-action="attach-active"], [data-action="attach-files"], [data-action="clear-attachments"]',
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

  function appendUserMessage(text, attachments) {
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

  function clearConversation() {
    state.streaming = null;
    state.pendingPrompt = null;
    state.attachments = [];
    state.busy = false;
    els.messages.querySelectorAll('.message').forEach(function (node) {
      node.remove();
    });
    els.prompt.value = '';
    els.mode.value = 'ask';
    autoResize();
    renderAttachmentBar();
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
    if (prompt.length === 0 && state.attachments.length === 0) {
      showToast('Add a question or attach code first.', 'warn');
      els.prompt.focus();
      return;
    }
    if (prompt.length > state.maxPromptChars) {
      showToast('The prompt is too long. Shorten it before sending.', 'warn');
      return;
    }

    state.pendingPrompt = els.prompt.value;
    post({ type: 'send', prompt: els.prompt.value, mode: els.mode.value });
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
        if (message.version) {
          document.title = 'QuantsMind AI Coder ' + message.version;
        }
        renderStatus();
        renderAttachmentBar();
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
        els.prompt.value = typeof message.prompt === 'string' ? message.prompt : '';
        els.mode.value = message.mode || 'ask';
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
        appendUserMessage(message.text || '', message.attachments || []);
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
      default:
        break;
    }
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

  document.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }
    switch (button.dataset.action) {
      case 'attach-selection':
        post({ type: 'attachSelection' });
        break;
      case 'attach-active':
        post({ type: 'attachActiveFile' });
        break;
      case 'attach-files':
        post({ type: 'attachFiles' });
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
  renderAttachmentBar();
  setBusy(false);
  autoResize();
  post({ type: 'ready' });
})();
