import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private static readonly viewType = 'claudeCodeManagerDashboard';

  private disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, manager: SessionManager): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      DashboardPanel.current.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Claude Code Dashboard',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    DashboardPanel.current = new DashboardPanel(panel, context, manager);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager
  ) {
    this.update();

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        switch (msg.command) {
          case 'newSession':
            await vscode.commands.executeCommand('claudeCodeManager.newSession');
            break;
          case 'focus':
            this.manager.focus(msg.id);
            break;
          case 'kill':
            await this.manager.kill(msg.id, { confirm: true });
            break;
          case 'rename':
            this.manager.rename(msg.id, msg.name);
            break;
          case 'sendPrompt':
            this.manager.sendPrompt(msg.id, msg.prompt);
            break;
        }
      },
      null,
      this.disposables
    );

    this.disposables.push(this.manager.onDidChange(() => this.update()));
  }

  private update(): void {
    const sessions = this.manager.list().map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
    }));
    this.panel.webview.html = this.render(sessions);
  }

  private render(sessions: any[]): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const data = JSON.stringify(sessions).replace(/</g, '\\u003c');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Claude Code Dashboard</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .stats { font-size: 12px; color: var(--vscode-descriptionForeground); }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0;
    padding: 6px 12px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card h2 {
    font-size: 14px; margin: 0; font-weight: 600;
    display: flex; align-items: center; gap: 6px;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .status-pill.s-idle       { background: rgba(140, 140, 140, 0.18); color: var(--vscode-descriptionForeground); }
  .status-pill.s-busy       { background: rgba(56, 139, 253, 0.20); color: #58a6ff; }
  .status-pill.s-question   { background: rgba(255, 184, 0, 0.22); color: #d29922; }
  .status-pill.s-permission { background: rgba(255, 122, 0, 0.22); color: #ff9b50; }
  .status-pill.s-done       { background: rgba(63, 185, 80, 0.20); color: #56d364; }
  .status-pill.s-exited     { background: rgba(140, 140, 140, 0.18); color: var(--vscode-descriptionForeground); }
  .card.s-busy { border-color: rgba(56, 139, 253, 0.45); }
  .card.s-question { border-color: rgba(255, 184, 0, 0.50); }
  .card.s-permission { border-color: rgba(255, 122, 0, 0.55); }
  .card.s-done { border-color: rgba(63, 185, 80, 0.45); }
  .meta { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .cwd { font-family: var(--vscode-editor-font-family); word-break: break-all; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { font-size: 11px; padding: 4px 8px; }
  .prompt-row { display: flex; gap: 6px; }
  .prompt-row input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 4px 6px;
    font-size: 12px;
  }
  .empty {
    text-align: center;
    padding: 48px 16px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>Claude Code Sessions</h1>
    <div class="stats" id="stats"></div>
  </div>
  <button id="new">+ New Session</button>
</header>
<div id="root"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const sessions = ${data};

  const root = document.getElementById('root');
  const stats = document.getElementById('stats');
  document.getElementById('new').onclick = () => vscode.postMessage({ command: 'newSession' });

  function fmtTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return d.toLocaleDateString();
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render() {
    stats.textContent = sessions.length + ' active session' + (sessions.length === 1 ? '' : 's');

    if (sessions.length === 0) {
      root.innerHTML = '<div class="empty">No active sessions. Click <strong>+ New Session</strong> to start one.</div>';
      return;
    }

    root.innerHTML = '<div class="grid">' + sessions.map(s => \`
      <div class="card s-\${s.status}" data-id="\${s.id}">
        <h2>\${escape(s.name)} <span class="status-pill s-\${s.status}">\${s.status}</span></h2>
        <div class="meta">Started \${fmtTime(s.startedAt)}</div>
        <div class="meta cwd">\${escape(s.cwd)}</div>
        <div class="prompt-row">
          <input type="text" placeholder="Send prompt..." data-prompt-for="\${s.id}">
          <button class="secondary" data-send="\${s.id}">Send</button>
        </div>
        <div class="actions">
          <button data-focus="\${s.id}">Focus</button>
          <button class="secondary" data-rename="\${s.id}">Rename</button>
          <button class="secondary" data-kill="\${s.id}">Kill</button>
        </div>
      </div>
    \`).join('') + '</div>';

    root.querySelectorAll('[data-focus]').forEach(b =>
      b.onclick = () => vscode.postMessage({ command: 'focus', id: b.dataset.focus }));
    root.querySelectorAll('[data-kill]').forEach(b =>
      b.onclick = () => vscode.postMessage({ command: 'kill', id: b.dataset.kill }));
    root.querySelectorAll('[data-rename]').forEach(b =>
      b.onclick = () => {
        const name = prompt('New name?');
        if (name) vscode.postMessage({ command: 'rename', id: b.dataset.rename, name });
      });
    root.querySelectorAll('[data-send]').forEach(b =>
      b.onclick = () => {
        const input = root.querySelector('[data-prompt-for="' + b.dataset.send + '"]');
        if (input && input.value.trim()) {
          vscode.postMessage({ command: 'sendPrompt', id: b.dataset.send, prompt: input.value });
          input.value = '';
        }
      });
  }

  render();
</script>
</body>
</html>`;
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
