import * as vscode from 'vscode';
import { SessionManager, ClaudeSession } from './sessionManager';

const CHECK_INTERVAL_MS = 30_000;

/**
 * Detects when sessions have been closed and flips them to `exited` so the
 * sidebar/dashboard reflect reality. Two signals:
 *
 * 1. JSONL inactivity — if a session's JSONL hasn't been written in
 *    `claudeCodeManager.autoExit.idleMs` (default 10 min), assume the
 *    underlying conversation is dormant or closed.
 * 2. Tab close — when an `anthropic.claude-code` webview tab closes, look
 *    for an extension shadow whose name appears in the closed tab's label
 *    and mark it exited immediately.
 */
export class LifecycleMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private subs: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private manager: SessionManager) {
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    // Also tick on session changes so newly-restored stale sessions get
    // re-evaluated promptly.
    this.subs.push(this.manager.onDidChange(() => this.tick()));
    this.subs.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        if (e.closed.length === 0) return;
        for (const tab of e.closed) {
          if (!isClaudeWebviewTab(tab)) continue;
          this.handleClosedTab(tab);
        }
      })
    );
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.subs.length) {
      const d = this.subs.pop();
      if (d) d.dispose();
    }
  }

  private idleMs(): number {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<number>('autoExit.idleMs', 600_000);
  }

  private tick(): void {
    if (this.disposed) return;
    const threshold = this.idleMs();
    if (threshold <= 0) return;
    const now = Date.now();
    for (const s of this.manager.list()) {
      if (s.status === 'exited') continue;
      const idle = now - s.lastActivityAt.getTime();
      if (idle > threshold) {
        this.manager.markExited(s.id);
      }
    }
  }

  private handleClosedTab(tab: vscode.Tab): void {
    const label = tab.label.toLowerCase().trim();
    if (!label) return;
    // Find an open extension shadow whose name appears in the tab's label.
    // Tabs from the official extension typically use the conversation's
    // auto-derived title, which is also what we use for sessions.
    let best: ClaudeSession | undefined;
    for (const s of this.manager.list()) {
      if (s.kind !== 'extension') continue;
      if (s.status === 'exited') continue;
      const name = s.name.toLowerCase().trim();
      if (!name) continue;
      if (label.includes(name) || name.includes(label)) {
        best = s;
        break;
      }
    }
    if (best) this.manager.markExited(best.id);
  }
}

function isClaudeWebviewTab(tab: vscode.Tab): boolean {
  const input = tab.input;
  if (!input || typeof input !== 'object') return false;
  // Avoid hard `instanceof` since the constructor isn't always exported in
  // older typings — duck-type on the `viewType` field instead.
  const vt = (input as { viewType?: unknown }).viewType;
  if (typeof vt !== 'string') return false;
  const lower = vt.toLowerCase();
  return lower.includes('claude') || lower.includes('anthropic');
}
