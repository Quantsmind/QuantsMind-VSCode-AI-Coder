import { expect } from 'chai';
import { parseWebviewMessage } from '../../src/chat/protocol';

suite('webview message parsing', () => {
  test('accepts every parameterless command', () => {
    const types = [
      'ready',
      'stop',
      'newChat',
      'attachSelection',
      'attachActiveFile',
      'attachFiles',
      'clearAttachments',
      'explainSelection',
      'setApiKey',
      'clearApiKey',
      'openSettings',
      'showLog',
      'refreshStatus',
      'refreshSessions',
      'newConversation',
      'summarizeWorkspace',
      'inspectRepository',
    ] as const;

    for (const type of types) {
      expect(parseWebviewMessage({ type })).to.deep.equal({ type });
    }
  });

  test('parses session lifecycle and approval messages', () => {
    expect(parseWebviewMessage({ type: 'startSession', requirement: 'Add tests' })).to.deep.equal({
      type: 'startSession',
      requirement: 'Add tests',
    });

    for (const type of [
      'generateRepair',
      'pauseSession',
      'resumeSession',
      'cancelSession',
      'restoreSession',
      'deleteSession',
      'focusSession',
      'undoSession',
    ]) {
      expect(parseWebviewMessage({ type, sessionId: 'session-1' })).to.deep.equal({
        type,
        sessionId: 'session-1',
      });
    }

    for (const type of ['approvePlan', 'rejectPlan', 'rejectChangeSet', 'rejectRepair']) {
      expect(
        parseWebviewMessage({
          type,
          sessionId: 'session-1',
          requestId: 'approval-1',
        }),
      ).to.deep.equal({ type, sessionId: 'session-1', requestId: 'approval-1' });
    }

    expect(
      parseWebviewMessage({
        type: 'approveChangeSet',
        sessionId: 'session-1',
        ids: ['change-1', 'change-2'],
        requestId: 'approval-1',
      }),
    ).to.deep.equal({
      type: 'approveChangeSet',
      sessionId: 'session-1',
      ids: ['change-1', 'change-2'],
      requestId: 'approval-1',
    });
    expect(
      parseWebviewMessage({
        type: 'approveRepair',
        sessionId: 'session-1',
        ids: ['r1'],
        requestId: 'approval-1',
      }),
    ).to.deep.equal({
      type: 'approveRepair',
      sessionId: 'session-1',
      ids: ['r1'],
      requestId: 'approval-1',
    });
    expect(
      parseWebviewMessage({
        type: 'requestValidation',
        sessionId: 'session-1',
        command: 'npm run test:unit',
      }),
    ).to.deep.equal({
      type: 'requestValidation',
      sessionId: 'session-1',
      command: 'npm run test:unit',
    });
    expect(
      parseWebviewMessage({
        type: 'approveValidation',
        sessionId: 'session-1',
        requestId: 'approval-1',
      }),
    ).to.deep.equal({
      type: 'approveValidation',
      sessionId: 'session-1',
      requestId: 'approval-1',
    });
    expect(
      parseWebviewMessage({
        type: 'rejectValidation',
        sessionId: 'session-1',
        requestId: 'approval-1',
      }),
    ).to.deep.equal({
      type: 'rejectValidation',
      sessionId: 'session-1',
      requestId: 'approval-1',
    });
  });

  test('drops non-string approval ids and caps the selection', () => {
    const ids = Array.from({ length: 150 }, (_value, index) => `change-${index + 1}`);
    const parsed = parseWebviewMessage({
      type: 'approveChangeSet',
      sessionId: 'session-1',
      ids: [...ids, 42, ''],
      requestId: 'approval-1',
    });
    expect(parsed).to.deep.equal({
      type: 'approveChangeSet',
      sessionId: 'session-1',
      ids: ids.slice(0, 100),
      requestId: 'approval-1',
    });
  });

  test('drops an approval that does not name the pending request', () => {
    for (const type of [
      'approvePlan',
      'rejectPlan',
      'rejectChangeSet',
      'rejectRepair',
      'approveValidation',
      'rejectValidation',
    ]) {
      expect(parseWebviewMessage({ type, sessionId: 'session-1' }), type).to.equal(undefined);
      expect(parseWebviewMessage({ type, sessionId: 'session-1', requestId: '' }), type).to.equal(
        undefined,
      );
      expect(
        parseWebviewMessage({ type, sessionId: 'session-1', requestId: 42 }),
        type,
      ).to.equal(undefined);
      expect(
        parseWebviewMessage({ type, sessionId: 'session-1', requestId: 'x'.repeat(201) }),
        type,
      ).to.equal(undefined);
    }

    expect(
      parseWebviewMessage({ type: 'approveChangeSet', sessionId: 'session-1', ids: ['change-1'] }),
    ).to.equal(undefined);
    expect(
      parseWebviewMessage({
        type: 'approveRepair',
        sessionId: 'session-1',
        ids: ['r1'],
        requestId: '',
      }),
    ).to.equal(undefined);
  });

  test('rejects malformed session messages', () => {
    expect(parseWebviewMessage({ type: 'startSession', requirement: 42 })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'approvePlan' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'approvePlan', sessionId: '' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'approvePlan', sessionId: 'x'.repeat(201) })).to.equal(
      undefined,
    );
    expect(
      parseWebviewMessage({ type: 'approveRepair', sessionId: 'session-1', ids: 'all' }),
    ).to.equal(undefined);
    expect(
      parseWebviewMessage({ type: 'requestValidation', sessionId: 'session-1', command: 7 }),
    ).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'validateSession', sessionId: 'session-1' })).to.equal(
      undefined,
    );
    expect(parseWebviewMessage({ type: 'deleteSession', sessionId: { id: 'x' } })).to.equal(
      undefined,
    );
  });

  test('parses a send message and preserves a valid mode', () => {
    expect(parseWebviewMessage({ type: 'send', prompt: 'Explain this', mode: 'explain' })).to.deep.equal({
      type: 'send',
      prompt: 'Explain this',
      mode: 'explain',
    });
  });

  test('falls back to ask for an unknown mode', () => {
    expect(parseWebviewMessage({ type: 'send', prompt: 'Hi', mode: 'hack' })).to.deep.equal({
      type: 'send',
      prompt: 'Hi',
      mode: 'ask',
    });
    expect(parseWebviewMessage({ type: 'send', prompt: 'Hi' })).to.deep.equal({
      type: 'send',
      prompt: 'Hi',
      mode: 'ask',
    });
  });

  test('rejects send messages without a prompt', () => {
    expect(parseWebviewMessage({ type: 'send', mode: 'ask' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'send', prompt: 42 })).to.equal(undefined);
  });

  test('accepts valid attachment removal ids', () => {
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 'attachment-1' })).to.deep.equal({
      type: 'removeAttachment',
      id: 'attachment-1',
    });
  });

  test('rejects malformed attachment removal ids', () => {
    expect(parseWebviewMessage({ type: 'removeAttachment' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: '' })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 'x'.repeat(101) })).to.equal(undefined);
    expect(parseWebviewMessage({ type: 'removeAttachment', id: 7 })).to.equal(undefined);
  });

  test('ignores unknown, malformed and non-object messages', () => {
    expect(parseWebviewMessage({ type: 'runCommand', command: 'rm -rf /' })).to.equal(undefined);
    expect(parseWebviewMessage({})).to.equal(undefined);
    expect(parseWebviewMessage(undefined)).to.equal(undefined);
    expect(parseWebviewMessage(null)).to.equal(undefined);
    expect(parseWebviewMessage('ready')).to.equal(undefined);
    expect(parseWebviewMessage(42)).to.equal(undefined);
  });

  test('parses repository inspection messages', () => {
    expect(parseWebviewMessage({ type: 'inspectRepository' })).to.deep.equal({
      type: 'inspectRepository',
    });
    expect(
      parseWebviewMessage({ type: 'explainRepositoryContext', query: 'login' }),
    ).to.deep.equal({ type: 'explainRepositoryContext', query: 'login' });
    expect(parseWebviewMessage({ type: 'explainRepositoryContext' })).to.equal(undefined);
  });
});
