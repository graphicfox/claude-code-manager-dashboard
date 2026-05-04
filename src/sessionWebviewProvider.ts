import * as vscode from 'vscode';
import {
  SessionManager,
  ClaudeSession,
  SessionStatus,
  STATUS_ORDER,
  SessionUsage,
} from './sessionManager';
import { ExternalSessionTracker, ExternalSession } from './externalSessionTracker';
import { CrossWindowCommandSender, revealVSCodeWindow } from './crossWindowCommands';

interface SessionVM {
  id: string;
  name: string;
  cwd: string;
  cwdRelative: string;
  status: SessionStatus;
  startedAt: string;
  usageLine: string;
  external: boolean;
  windowId?: string;
  workspaceFolder?: string;
  workspaceName?: string;
}

export class SessionWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCodeSessions';

  private view?: vscode.WebviewView;
  private pendingBadge: vscode.ViewBadge | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: SessionManager,
    private readonly tracker: ExternalSessionTracker,
    private readonly sender: CrossWindowCommandSender
  ) {
    this.context.subscriptions.push(
      this.manager.onDidChange(() => this.update()),
      this.tracker.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('claudeCodeManager.showAllWindows')) {
          this.update();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    if (this.pendingBadge !== undefined) view.badge = this.pendingBadge;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'newSession':
          await vscode.commands.executeCommand('claudeCodeManager.newSession');
          break;
        case 'focus':
          if (this.manager.get(msg.id)) this.manager.focus(msg.id);
          break;
        case 'kill': {
          if (!this.manager.get(msg.id)) break;
          const confirm = vscode.workspace
            .getConfiguration('claudeCodeManager')
            .get<boolean>('confirmKill', true);
          await this.manager.kill(msg.id, { confirm });
          break;
        }
        case 'rename': {
          const current = this.manager.get(msg.id);
          if (!current) break;
          const name = await vscode.window.showInputBox({
            prompt: 'New name for session',
            value: current.name,
          });
          if (name) this.manager.rename(msg.id, name);
          break;
        }
        case 'setStatus':
          if (this.manager.get(msg.id)) {
            this.manager.setStatus(msg.id, msg.status as SessionStatus);
          }
          break;
        case 'sendPrompt': {
          if (!this.manager.get(msg.id)) break;
          const prompt = await vscode.window.showInputBox({
            prompt: 'Prompt to send to the Claude session',
            placeHolder: 'e.g. /clear, or a free-form instruction',
          });
          if (prompt) this.manager.sendPrompt(msg.id, prompt);
          break;
        }
        case 'revealExternal':
          if (typeof msg.windowId === 'string' && typeof msg.id === 'string') {
            // Bring the target window to the front via the OS first, then
            // tell that window to surface the right terminal.
            revealVSCodeWindow(
              typeof msg.workspaceFolder === 'string' ? msg.workspaceFolder : undefined,
              typeof msg.workspaceName === 'string' ? msg.workspaceName : undefined
            );
            await this.sender.requestFocus(msg.windowId, msg.id);
          }
          break;
        case 'openDashboard':
          await vscode.commands.executeCommand('claudeCodeManager.openDashboard');
          break;
      }
    });

    this.update();
  }

  refresh(): void {
    this.update();
  }

  setBadge(badge: { value: number; tooltip: string } | undefined): void {
    this.pendingBadge = badge;
    if (this.view) this.view.badge = badge;
  }

  private update(): void {
    if (!this.view) return;
    const local: SessionVM[] = this.manager.list().map((s) => this.toVM(s));
    const showExternal = vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('showAllWindows', true);
    const external: SessionVM[] = showExternal
      ? this.tracker.list().map((s) => this.toExternalVM(s))
      : [];
    this.view.webview.html = this.render(local, external);
  }

  private toVM(s: ClaudeSession): SessionVM {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      cwdRelative: vscode.workspace.asRelativePath(s.cwd, false),
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      usageLine: formatUsageLineFromUsage(s.usage),
      external: false,
    };
  }

  private toExternalVM(s: ExternalSession): SessionVM {
    return {
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      cwdRelative: lastSegment(s.cwd) || s.cwd,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      usageLine: formatUsageLineFromUsage(s.usage),
      external: true,
      windowId: s.windowId,
      workspaceFolder: s.workspaceFolder,
      workspaceName: s.workspaceName,
    };
  }

  private render(local: SessionVM[], external: SessionVM[]): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const data = JSON.stringify({ local, external }).replace(/</g, '\\u003c');
    const statusOrder = JSON.stringify(STATUS_ORDER);

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    margin: 0;
    padding: 8px;
    font-size: 13px;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .toolbar button {
    flex: 1;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0;
    padding: 6px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
  }
  .toolbar button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .toolbar button:hover { filter: brightness(1.1); }

  .session {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 12px 12px 10px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .session:hover {
    border-color: var(--vscode-focusBorder);
  }
  .session.s-busy { background: rgba(56, 139, 253, 0.10); border-color: rgba(56, 139, 253, 0.45); }
  .session.s-question { background: rgba(255, 184, 0, 0.10); border-color: rgba(255, 184, 0, 0.50); }
  .session.s-permission { background: rgba(255, 122, 0, 0.12); border-color: rgba(255, 122, 0, 0.55); }
  .session.s-done { background: rgba(63, 185, 80, 0.10); border-color: rgba(63, 185, 80, 0.45); }
  .session.s-idle { background: transparent; }
  .session.s-exited { opacity: 0.6; }
  .session.external { border-style: dashed; opacity: 0.9; }
  .session.external:hover { opacity: 1; }
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
  .section-header {
    margin: 14px 2px 6px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cwd {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .usage {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    opacity: 0.75;
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .status-pill svg { width: 11px; height: 11px; }
  .status-pill.s-idle       { background: rgba(140, 140, 140, 0.18); color: var(--vscode-descriptionForeground); }
  .status-pill.s-busy       { background: rgba(56, 139, 253, 0.20); color: #58a6ff; }
  .status-pill.s-question   { background: rgba(255, 184, 0, 0.22); color: #d29922; }
  .status-pill.s-permission { background: rgba(255, 122, 0, 0.22); color: #ff9b50; }
  .status-pill.s-done       { background: rgba(63, 185, 80, 0.20); color: #56d364; }
  .status-pill.s-exited     { background: rgba(140, 140, 140, 0.18); color: var(--vscode-descriptionForeground); }

  .actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .actions button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .actions button:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .actions .danger:hover {
    background: var(--vscode-inputValidation-errorBackground, rgba(255, 80, 80, 0.15));
    border-color: var(--vscode-errorForeground);
    color: var(--vscode-errorForeground);
  }

  .status-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .status-row button {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 2px 7px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    opacity: 0.65;
  }
  .status-row button:hover { opacity: 1; }
  .status-row button.active { opacity: 1; border-color: currentColor; }
  .status-row button.s-idle.active       { color: var(--vscode-foreground); }
  .status-row button.s-busy.active       { color: #58a6ff; }
  .status-row button.s-question.active   { color: #d29922; }
  .status-row button.s-permission.active { color: #ff9b50; }
  .status-row button.s-done.active       { color: #56d364; }

  .empty {
    text-align: center;
    padding: 32px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .empty button {
    margin-top: 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 0;
    padding: 6px 12px;
    border-radius: 3px;
    cursor: pointer;
  }
</style>
</head>
<body>
<div class="toolbar">
  <button id="new">+ New Session</button>
  <button id="dashboard" class="secondary" title="Open Dashboard">Dashboard</button>
</div>
<div id="root"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const data = ${data};
  const STATUSES = ${statusOrder};
  const root = document.getElementById('root');

  const ICONS = {
    idle:       '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
    busy:       '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 1 0 6 6h-1.5A4.5 4.5 0 1 1 8 3.5V2z"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite"/></path></svg>',
    question:   '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 12v-1.5h1.5V12h-1.5zm.75-3a.75.75 0 0 1-.75-.75c0-1 1.5-1.5 1.5-2.5a1 1 0 0 0-2 0H5.25a2.5 2.5 0 1 1 5 0c0 1.5-1.5 2-1.5 2.75A.75.75 0 0 1 8 9z"/></svg>',
    permission: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L3 3v4c0 3.5 2 6.5 5 7.5 3-1 5-4 5-7.5V3L8 1zm0 1.6L11.5 4v3c0 2.6-1.4 5-3.5 5.8-2.1-.8-3.5-3.2-3.5-5.8V4L8 2.6z"/></svg>',
    done:       '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7 7a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06L6.25 10.69l6.47-6.47a.75.75 0 0 1 1.06 0z"/></svg>',
    exited:     '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 4l8 8" stroke="currentColor" stroke-width="1.5"/></svg>',
  };
  const LABELS = { idle: 'Idle', busy: 'Busy', question: 'Question', permission: 'Permission', done: 'Done', exited: 'Exited' };

  document.getElementById('new').onclick = () => vscode.postMessage({ command: 'newSession' });
  document.getElementById('dashboard').onclick = () => vscode.postMessage({ command: 'openDashboard' });

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function localCard(s) {
    const statusButtons = STATUSES.map(st => \`
      <button class="s-\${st} \${s.status === st ? 'active' : ''}" data-set-status="\${st}" data-id="\${s.id}" title="Mark as \${LABELS[st]}">\${LABELS[st]}</button>
    \`).join('');
    const usage = s.usageLine ? \`<div class="usage">\${escape(s.usageLine)}</div>\` : '';
    return \`
      <div class="session s-\${s.status}" data-id="\${s.id}">
        <div class="row">
          <span class="name" data-focus="\${s.id}">\${escape(s.name)}</span>
          <span class="status-pill s-\${s.status}">\${ICONS[s.status]}\${LABELS[s.status]}</span>
        </div>
        <div class="cwd">\${escape(s.cwdRelative || s.cwd)}</div>
        \${usage}
        <div class="status-row">\${statusButtons}</div>
        <div class="actions">
          <button data-focus="\${s.id}">Focus</button>
          <button data-prompt="\${s.id}">Send…</button>
          <button data-rename="\${s.id}">Rename</button>
          <button class="danger" data-kill="\${s.id}">Kill</button>
        </div>
      </div>
    \`;
  }

  function externalCard(s) {
    const usage = s.usageLine ? \`<div class="usage">\${escape(s.usageLine)}</div>\` : '';
    return \`
      <div class="session external s-\${s.status}" data-reveal-id="\${s.id}" data-window-id="\${escape(s.windowId || '')}" data-workspace-folder="\${escape(s.workspaceFolder || '')}" data-workspace-name="\${escape(s.workspaceName || '')}" title="Click to reveal in the owning VS Code window">
        <div class="row">
          <span class="name">\${escape(s.name)}</span>
          <span class="status-pill s-\${s.status}">\${ICONS[s.status]}\${LABELS[s.status]}</span>
        </div>
        <div class="row" style="gap:6px;">
          <span class="external-tag">Other window</span>
          <span class="cwd" style="flex:1;">\${escape(s.cwdRelative || s.cwd)}</span>
        </div>
        \${usage}
      </div>
    \`;
  }

  function render() {
    const total = data.local.length + data.external.length;
    if (total === 0) {
      root.innerHTML = '<div class="empty">No active Claude sessions.<br><button id="empty-new">+ New Session</button></div>';
      document.getElementById('empty-new').onclick = () => vscode.postMessage({ command: 'newSession' });
      return;
    }

    let html = '';
    if (data.local.length > 0) {
      html += data.local.map(localCard).join('');
    }
    if (data.external.length > 0) {
      html += '<div class="section-header">Other windows</div>';
      html += data.external.map(externalCard).join('');
    }
    root.innerHTML = html;

    root.querySelectorAll('[data-focus]').forEach(el => {
      el.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ command: 'focus', id: el.dataset.focus }); };
    });
    root.querySelectorAll('[data-kill]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ command: 'kill', id: b.dataset.kill }); };
    });
    root.querySelectorAll('[data-rename]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ command: 'rename', id: b.dataset.rename }); };
    });
    root.querySelectorAll('[data-prompt]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ command: 'sendPrompt', id: b.dataset.prompt }); };
    });
    root.querySelectorAll('[data-set-status]').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: 'setStatus', id: b.dataset.id, status: b.dataset.setStatus });
      };
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
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function formatUsageLineFromUsage(u: SessionUsage): string {
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
  if (total === 0) return '';
  const parts = [`${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens)} in`, `${formatTokens(u.outputTokens)} out`];
  if (u.costUsd > 0) parts.push(`$${u.costUsd.toFixed(u.costUsd < 1 ? 3 : 2)}`);
  return parts.join(' · ');
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function lastSegment(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
