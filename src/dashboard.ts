import * as vscode from 'vscode';
import { SessionManager, SessionUsage } from './sessionManager';
import { ExternalSessionTracker } from './externalSessionTracker';
import { CrossWindowCommandSender, revealVSCodeWindow } from './crossWindowCommands';

interface SessionTotals {
  input: number;
  output: number;
  cost: number;
}

function totalsFor(usages: SessionUsage[]): SessionTotals {
  return usages.reduce<SessionTotals>(
    (acc, u) => {
      acc.input += u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
      acc.output += u.outputTokens;
      acc.cost += u.costUsd;
      return acc;
    },
    { input: 0, output: 0, cost: 0 }
  );
}

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private static readonly viewType = 'claudeCodeManagerDashboard';

  private disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    manager: SessionManager,
    tracker: ExternalSessionTracker,
    sender: CrossWindowCommandSender
  ): void {
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

    DashboardPanel.current = new DashboardPanel(panel, manager, tracker, sender);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly manager: SessionManager,
    private readonly tracker: ExternalSessionTracker,
    private readonly sender: CrossWindowCommandSender
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
            if (this.manager.get(msg.id)) this.manager.focus(msg.id);
            break;
          case 'kill':
            if (this.manager.get(msg.id)) await this.manager.kill(msg.id, { confirm: true });
            break;
          case 'rename':
            if (this.manager.get(msg.id)) this.manager.rename(msg.id, msg.name);
            break;
          case 'sendPrompt':
            if (this.manager.get(msg.id)) this.manager.sendPrompt(msg.id, msg.prompt);
            break;
          case 'revealExternal':
            if (typeof msg.windowId === 'string' && typeof msg.id === 'string') {
              revealVSCodeWindow(
                typeof msg.workspaceFolder === 'string' ? msg.workspaceFolder : undefined,
                typeof msg.workspaceName === 'string' ? msg.workspaceName : undefined
              );
              await this.sender.requestFocus(msg.windowId, msg.id);
            }
            break;
          case 'openSettings':
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:kimmartini.claude-code-manager'
            );
            break;
          case 'clearClosed':
            await vscode.commands.executeCommand('claudeCodeManager.clearClosedSessions');
            break;
        }
      },
      null,
      this.disposables
    );

    this.disposables.push(
      this.manager.onDidChange(() => this.update()),
      this.tracker.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCodeManager.showAllWindows')) {
          this.update();
        }
      })
    );
  }

  private update(): void {
    const sessions = this.manager.list().map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      usage: s.usage,
      kind: s.kind,
      hasExtSessionId: !!s.extensionSessionId,
      external: false as const,
    }));
    const showExternal = vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('showAllWindows', true);
    const externalsRaw = showExternal ? this.tracker.list() : [];
    const externals = externalsRaw.map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      usage: s.usage,
      kind: s.kind ?? 'cli',
      windowId: s.windowId,
      workspaceFolder: s.workspaceFolder,
      workspaceName: s.workspaceName,
      external: true as const,
    }));
    const localTotals = totalsFor(sessions.map((s) => s.usage));
    const externalTotals = totalsFor(externals.map((s) => s.usage));
    this.panel.webview.html = this.render(sessions, externals, localTotals, externalTotals);
  }

  private render(
    sessions: any[],
    externals: any[],
    localTotals: SessionTotals,
    externalTotals: SessionTotals
  ): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const data = JSON.stringify({ sessions, externals }).replace(/</g, '\\u003c');
    const totalsData = JSON.stringify({ local: localTotals, external: externalTotals }).replace(/</g, '\\u003c');

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
  .card.external {
    border-style: dashed;
    opacity: 0.92;
    cursor: pointer;
  }
  .card.external:hover { opacity: 1; }
  .external-tag {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background, rgba(140,140,140,0.25));
    color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground));
    font-weight: 600;
  }
  .kind-tag {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 8px;
    background: rgba(140, 90, 220, 0.18);
    color: #c39bff;
    font-weight: 600;
  }
  .actions button[disabled],
  .prompt-row input[disabled],
  .prompt-row button[disabled] {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .section-header {
    margin: 18px 0 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-count {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 8px;
    background: var(--vscode-badge-background, rgba(140,140,140,0.25));
    color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground));
    letter-spacing: 0.4px;
  }
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
  .totals {
    padding: 8px 12px;
    margin-bottom: 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    font-size: 12px;
  }
  .totals-row {
    display: flex;
    gap: 16px;
    align-items: center;
  }
  .totals-row + .totals-row {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--vscode-panel-border);
  }
  .totals .scope {
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
    min-width: 110px;
  }
  .totals .num { font-weight: 600; color: var(--vscode-foreground); }
  .totals .label { color: var(--vscode-descriptionForeground); margin-right: 4px; }
  .usage { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<header>
  <div>
    <h1>Claude Code Sessions</h1>
    <div class="stats" id="stats"></div>
  </div>
  <div style="display:flex; gap:6px;">
    <button id="clearClosed" class="secondary" style="display:none;" title="Remove sessions in the Exited state">Clear closed</button>
    <button id="settings" class="secondary" title="Open Claude Code Manager settings">⚙ Settings</button>
    <button id="new">+ New Session</button>
  </div>
</header>
<div id="totals"></div>
<div id="root"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${data};
  const totals = ${totalsData};

  const root = document.getElementById('root');
  const stats = document.getElementById('stats');
  document.getElementById('new').onclick = () => vscode.postMessage({ command: 'newSession' });
  document.getElementById('settings').onclick = () => vscode.postMessage({ command: 'openSettings' });
  const clearClosedBtn = document.getElementById('clearClosed');
  clearClosedBtn.onclick = () => vscode.postMessage({ command: 'clearClosed' });

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

  function lastSeg(p) {
    if (!p) return '';
    const trimmed = String(p).replace(/[/\\\\]+$/, '');
    const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\\\'));
    return i >= 0 ? trimmed.slice(i + 1) : trimmed;
  }

  function fmtTokens(n) {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
    return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
  }
  function fmtCost(c) {
    return '$' + c.toFixed(c < 1 ? 3 : 2);
  }
  function usageLine(u) {
    const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
    if (total === 0) return '';
    const inAll = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
    const parts = [fmtTokens(inAll) + ' in', fmtTokens(u.outputTokens) + ' out'];
    if (u.costUsd > 0) parts.push(fmtCost(u.costUsd));
    return parts.join(' · ');
  }

  function totalsRow(label, t) {
    return '<div class="totals-row">' +
      '<span class="scope">' + label + '</span>' +
      '<div><span class="label">Input:</span><span class="num">' + fmtTokens(t.input) + '</span></div>' +
      '<div><span class="label">Output:</span><span class="num">' + fmtTokens(t.output) + '</span></div>' +
      (t.cost > 0 ? '<div><span class="label">Cost:</span><span class="num">' + fmtCost(t.cost) + '</span></div>' : '') +
      '</div>';
  }

  function localCardHtml(s) {
    const isExt = s.kind === 'extension';
    const usage = usageLine(s.usage);
    const kindTag = isExt ? '<span class="kind-tag" title="Owned by the Claude Code editor extension">Extension</span>' : '';
    const promptRow = isExt
      ? \`<div class="prompt-row">
          <input type="text" placeholder="Type prompts directly in the extension tab" disabled>
          <button class="secondary" disabled>Send</button>
        </div>\`
      : \`<div class="prompt-row">
          <input type="text" placeholder="Send prompt..." data-prompt-for="\${s.id}">
          <button class="secondary" data-send="\${s.id}">Send</button>
        </div>\`;
    const focusBtn = isExt
      ? (s.hasExtSessionId
        ? \`<button data-focus="\${s.id}" title="Focus the Claude Code extension tab for this session">Focus</button>\`
        : '<button disabled title="Send a prompt in the extension tab so the manager can capture this session\\u2019s id, then Focus will jump to it.">Focus</button>')
      : \`<button data-focus="\${s.id}">Focus</button>\`;
    const killLabel = isExt ? 'Remove' : 'Kill';
    const killTitle = isExt ? 'Remove from list (does not close the extension tab)' : 'Kill the CLI session';
    return \`
      <div class="card s-\${s.status}" data-id="\${s.id}">
        <h2>\${escape(s.name)} <span class="status-pill s-\${s.status}">\${s.status}</span> \${kindTag}</h2>
        <div class="meta">Started \${fmtTime(s.startedAt)}</div>
        <div class="meta cwd">\${escape(s.cwd)}</div>
        \${usage ? '<div class="usage">' + escape(usage) + '</div>' : ''}
        \${promptRow}
        <div class="actions">
          \${focusBtn}
          <button class="secondary" data-rename="\${s.id}">Rename</button>
          <button class="secondary" data-kill="\${s.id}" title="\${killTitle}">\${killLabel}</button>
        </div>
      </div>\`;
  }

  function externalCardHtml(s) {
    const isExt = s.kind === 'extension';
    const usage = usageLine(s.usage);
    const kindTag = isExt ? '<span class="kind-tag" title="Owned by the Claude Code editor extension">Extension</span>' : '';
    return \`
      <div class="card external s-\${s.status}" data-reveal-id="\${s.id}" data-window-id="\${escape(s.windowId || '')}" data-workspace-folder="\${escape(s.workspaceFolder || '')}" data-workspace-name="\${escape(s.workspaceName || '')}" title="Click to reveal in the owning editor window">
        <h2>
          \${escape(s.name)}
          <span class="status-pill s-\${s.status}">\${s.status}</span>
          \${kindTag}
        </h2>
        <div class="meta">Started \${fmtTime(s.startedAt)}</div>
        <div class="meta cwd">\${escape(s.cwd)}</div>
        \${usage ? '<div class="usage">' + escape(usage) + '</div>' : ''}
      </div>\`;
  }

  function render() {
    const total = data.sessions.length + data.externals.length;
    const closed = data.sessions.filter(function (s) { return s.status === 'exited'; }).length;
    stats.textContent = total + ' active session' + (total === 1 ? '' : 's') +
      (data.externals.length > 0 ? ' (' + data.sessions.length + ' here, ' + data.externals.length + ' other)' : '');
    if (closed > 0) {
      clearClosedBtn.style.display = '';
      clearClosedBtn.textContent = 'Clear ' + closed + ' closed';
    } else {
      clearClosedBtn.style.display = 'none';
    }

    const totalsEl = document.getElementById('totals');
    const localHas = totals.local.input + totals.local.output > 0;
    const externalHas = totals.external.input + totals.external.output > 0;
    if (localHas || externalHas) {
      totalsEl.className = 'totals';
      let inner = '';
      if (data.externals.length > 0) {
        inner += totalsRow('This window', totals.local);
        inner += totalsRow('Other windows', totals.external);
      } else {
        inner += totalsRow('Total', totals.local);
      }
      totalsEl.innerHTML = inner;
    } else {
      totalsEl.className = '';
      totalsEl.innerHTML = '';
    }

    if (total === 0) {
      root.innerHTML = '<div class="empty">No active sessions. Click <strong>+ New Session</strong> to start one.</div>';
      return;
    }

    let html = '';
    if (data.sessions.length > 0) {
      html += '<div class="grid">' + data.sessions.map(localCardHtml).join('') + '</div>';
    }
    if (data.externals.length > 0) {
      const groups = new Map();
      for (const s of data.externals) {
        const key = s.windowId || '__unknown';
        if (!groups.has(key)) {
          groups.set(key, {
            label: s.workspaceName || lastSeg(s.workspaceFolder || '') || 'Other window',
            sessions: [],
          });
        }
        groups.get(key).sessions.push(s);
      }
      for (const g of groups.values()) {
        const count = g.sessions.length;
        html += '<div class="section-header">' + escape(g.label) +
          ' <span class="section-count">' + count + '</span></div>';
        html += '<div class="grid">' + g.sessions.map(externalCardHtml).join('') + '</div>';
      }
    }
    root.innerHTML = html;

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
    root.querySelectorAll('[data-reveal-id]').forEach(el => {
      el.onclick = () => {
        vscode.postMessage({
          command: 'revealExternal',
          id: el.dataset.revealId,
          windowId: el.dataset.windowId,
          workspaceFolder: el.dataset.workspaceFolder,
          workspaceName: el.dataset.workspaceName,
        });
      };
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
