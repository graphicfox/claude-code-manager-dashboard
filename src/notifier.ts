import * as vscode from 'vscode';
import { SessionManager, SessionStatus } from './sessionManager';
import { SessionWebviewProvider } from './sessionWebviewProvider';

type NotifyMode = 'toast' | 'statusBar' | 'none';

const ATTENTION_STATES: SessionStatus[] = ['question', 'permission'];

/**
 * Surfaces sessions that need user attention.
 *
 * - Fires a notification (toast or status-bar message) when a session
 *   transitions *into* an attention state (question or permission).
 * - Updates the activity-bar badge to reflect how many sessions are
 *   currently in an attention state.
 *
 * The webview provider exposes `setBadge` which writes through to
 * `WebviewView.badge` — VS Code renders that as the badge on the activity
 * bar icon and the view title.
 */
export class Notifier implements vscode.Disposable {
  private subscriptions: vscode.Disposable[] = [];
  private lastBadgeCount = -1;

  constructor(
    private manager: SessionManager,
    private webview: SessionWebviewProvider
  ) {
    this.subscriptions.push(
      manager.onDidChangeStatus((change) => {
        // Notify when transitioning *into* an attention state.
        if (
          ATTENTION_STATES.includes(change.to) &&
          !ATTENTION_STATES.includes(change.from)
        ) {
          void this.notify(change.id, change.to);
        }
        this.updateBadge();
      }),
      manager.onDidChange(() => this.updateBadge())
    );
    this.updateBadge();
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.subscriptions = [];
  }

  private mode(): NotifyMode {
    const m = vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<string>('notifications.mode', 'toast');
    if (m === 'toast' || m === 'statusBar' || m === 'none') return m;
    return 'toast';
  }

  private async notify(sessionId: string, state: SessionStatus): Promise<void> {
    const session = this.manager.get(sessionId);
    if (!session) return;
    const mode = this.mode();
    if (mode === 'none') return;

    const verb = state === 'question' ? 'has a question' : 'is waiting for permission';
    const message = `Claude session "${session.name}" ${verb}.`;

    if (mode === 'statusBar') {
      vscode.window.setStatusBarMessage(`$(bell) ${message}`, 6000);
      return;
    }

    // toast
    const choice = await vscode.window.showInformationMessage(message, 'Focus');
    if (choice === 'Focus') {
      this.manager.focus(sessionId);
    }
  }

  private updateBadge(): void {
    const count = this.manager
      .list()
      .filter((s) => ATTENTION_STATES.includes(s.status)).length;
    if (count === this.lastBadgeCount) return;
    this.lastBadgeCount = count;
    if (count === 0) {
      this.webview.setBadge(undefined);
    } else {
      this.webview.setBadge({
        value: count,
        tooltip:
          count === 1
            ? '1 Claude session needs attention'
            : `${count} Claude sessions need attention`,
      });
    }
  }
}
