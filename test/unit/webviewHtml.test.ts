import { expect } from 'chai';
import { renderChatHtml } from '../../src/chat/webviewHtml';

const NONCE = 'abc123nonce';

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
    expect(html).to.contain('data-action="attach-relevant"');
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
