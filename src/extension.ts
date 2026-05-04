import * as vscode from 'vscode';
import { SessionManager, STATUS_ORDER, SessionStatus } from './sessionManager';
import { SessionWebviewProvider } from './sessionWebviewProvider';
import { DashboardPanel } from './dashboard';
import { StatusDetector } from './statusDetector';
import { Notifier } from './notifier';
import { listRecentSessions, pickRecentLabel } from './recentSessions';
import { ManifestPublisher } from './manifestPublisher';
import { ExternalSessionTracker } from './externalSessionTracker';
import {
  CrossWindowCommandSender,
  CrossWindowCommandReceiver,
  revealVSCodeWindow,
} from './crossWindowCommands';

export function activate(context: vscode.ExtensionContext): void {
  const manager = new SessionManager(context);
  const publisher = new ManifestPublisher(manager);
  const tracker = new ExternalSessionTracker(publisher.windowId());
  const sender = new CrossWindowCommandSender();
  const receiver = new CrossWindowCommandReceiver(
    publisher.windowId(),
    (sessionId) => {
      const session = manager.get(sessionId);
      if (!session) return;
      // The clicker handles OS-level window activation by running `code
      // <folder>` itself. Here we just surface the right terminal so it's
      // already foregrounded within this window when it comes up.
      session.terminal.show(false);
    }
  );
  const webviewProvider = new SessionWebviewProvider(context, manager, tracker, sender);
  const detector = new StatusDetector(manager);
  const notifier = new Notifier(manager, webviewProvider, tracker);
  context.subscriptions.push(detector, notifier, publisher, tracker, receiver);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SessionWebviewProvider.viewType,
      webviewProvider
    )
  );

  // --- Status bar -------------------------------------------------------
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'claudeCodeManager.openDashboard';
  context.subscriptions.push(statusBar);

  function updateStatusBar(): void {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('statusBar.enabled', true);
    if (!enabled) {
      statusBar.hide();
      return;
    }
    const sessions = manager.list();
    const externals = tracker.list();
    const total = sessions.length + externals.length;
    statusBar.text = `$(sparkle) Claude: ${total}`;
    if (total === 0) {
      statusBar.tooltip = 'No active Claude sessions — click to open dashboard';
    } else {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Claude Code Sessions (${total})**\n\n`);
      if (sessions.length > 0) {
        md.appendMarkdown(`_This window (${sessions.length})_\n\n`);
        for (const s of sessions) {
          const rel = vscode.workspace.asRelativePath(s.cwd, false);
          md.appendMarkdown(`- ${s.name} — \`${rel}\`\n`);
        }
        md.appendMarkdown('\n');
      }
      if (externals.length > 0) {
        md.appendMarkdown(`_Other windows (${externals.length})_\n\n`);
        for (const s of externals) {
          const cwdLabel = lastSegment(s.cwd) || s.cwd;
          md.appendMarkdown(`- ${s.name} — \`${cwdLabel}\`\n`);
        }
        md.appendMarkdown('\n');
      }
      md.appendMarkdown(`_Click to open dashboard_`);
      statusBar.tooltip = md;
    }
    statusBar.show();
  }

  context.subscriptions.push(manager.onDidChange(updateStatusBar));
  context.subscriptions.push(tracker.onDidChange(updateStatusBar));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('claudeCodeManager.statusBar.enabled') ||
        e.affectsConfiguration('claudeCodeManager.showAllWindows')
      ) {
        updateStatusBar();
      }
    })
  );
  updateStatusBar();

  // --- Restore on activate ---------------------------------------------
  void maybeRestore(manager);

  // Helper: resolve a session id, either passed directly or via quick-pick.
  async function resolveSessionId(arg?: string): Promise<string | undefined> {
    if (typeof arg === 'string' && manager.get(arg)) return arg;
    const sessions = manager.list();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No active Claude sessions.');
      return undefined;
    }
    if (sessions.length === 1) return sessions[0].id;
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.name,
        description: s.cwd,
        detail: `Started ${s.startedAt.toLocaleString()}`,
        id: s.id,
      })),
      { placeHolder: 'Select a Claude session' }
    );
    return pick?.id;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeManager.newSession', async () => {
      const session = manager.create();
      vscode.window.setStatusBarMessage(`Claude session "${session.name}" started`, 3000);
    }),

    vscode.commands.registerCommand('claudeCodeManager.newSessionInFolder', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Start Claude here',
      });
      if (!picked || picked.length === 0) return;
      manager.create({ cwd: picked[0].fsPath });
    }),

    vscode.commands.registerCommand(
      'claudeCodeManager.focusSession',
      async (arg?: string) => {
        const id = await resolveSessionId(arg);
        if (id) manager.focus(id);
      }
    ),

    vscode.commands.registerCommand(
      'claudeCodeManager.killSession',
      async (arg?: string) => {
        const id = await resolveSessionId(arg);
        if (!id) return;
        const confirm = vscode.workspace
          .getConfiguration('claudeCodeManager')
          .get<boolean>('confirmKill', true);
        await manager.kill(id, { confirm });
      }
    ),

    vscode.commands.registerCommand('claudeCodeManager.killAll', async () => {
      const confirm = vscode.workspace
        .getConfiguration('claudeCodeManager')
        .get<boolean>('confirmKill', true);
      const n = await manager.killAll({ confirm });
      if (n > 0) vscode.window.setStatusBarMessage(`Killed ${n} session(s)`, 3000);
    }),

    vscode.commands.registerCommand(
      'claudeCodeManager.renameSession',
      async (arg?: string) => {
        const id = await resolveSessionId(arg);
        if (!id) return;
        const current = manager.get(id);
        const name = await vscode.window.showInputBox({
          prompt: 'New name for session',
          value: current?.name,
        });
        if (name) manager.rename(id, name);
      }
    ),

    vscode.commands.registerCommand(
      'claudeCodeManager.sendPrompt',
      async (arg?: string) => {
        const id = await resolveSessionId(arg);
        if (!id) return;
        const prompt = await vscode.window.showInputBox({
          prompt: 'Prompt to send to the Claude session',
          placeHolder: 'e.g. /clear, or a free-form instruction',
        });
        if (prompt) manager.sendPrompt(id, prompt);
      }
    ),

    vscode.commands.registerCommand('claudeCodeManager.refresh', () => {
      webviewProvider.refresh();
    }),

    vscode.commands.registerCommand(
      'claudeCodeManager.setStatus',
      async (arg?: string) => {
        const id = await resolveSessionId(arg);
        if (!id) return;
        const pick = await vscode.window.showQuickPick(
          STATUS_ORDER.map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: s })),
          { placeHolder: 'Set session status' }
        );
        if (pick) manager.setStatus(id, pick.value as SessionStatus);
      }
    ),

    vscode.commands.registerCommand('claudeCodeManager.openDashboard', () => {
      DashboardPanel.show(context, manager, tracker, sender);
    }),

    vscode.commands.registerCommand('claudeCodeManager.resumeSession', async () => {
      const folders = vscode.workspace.workspaceFolders;
      const cwd = folders && folders.length > 0
        ? folders[0].uri.fsPath
        : process.env.HOME ?? process.cwd();
      const recent = await listRecentSessions(cwd);
      if (recent.length === 0) {
        vscode.window.showInformationMessage(
          `No prior Claude sessions found for ${cwd}.`
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        recent.map((s) => ({ ...pickRecentLabel(s), session: s })),
        {
          placeHolder: 'Resume a recent Claude session',
          matchOnDescription: true,
          matchOnDetail: true,
        }
      );
      if (!pick) return;
      manager.create({
        cwd: pick.session.cwd,
        resumeSessionId: pick.session.sessionId,
        name: pick.session.title,
      });
    }),

    vscode.commands.registerCommand('claudeCodeManager.restoreSessions', async () => {
      const persisted = manager.getPersisted();
      if (persisted.length === 0) {
        vscode.window.showInformationMessage('No saved Claude sessions to restore.');
        return;
      }
      const created = manager.restorePersisted();
      vscode.window.setStatusBarMessage(
        `Restored ${created} Claude session(s)`,
        3000
      );
    }),

    vscode.commands.registerCommand('claudeCodeManager.clearSavedSessions', async () => {
      const persisted = manager.getPersisted();
      if (persisted.length === 0) {
        vscode.window.showInformationMessage('No saved Claude sessions to clear.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Clear ${persisted.length} saved Claude session(s)? Currently running sessions are not affected.`,
        { modal: true },
        'Clear'
      );
      if (choice === 'Clear') {
        await manager.clearPersisted();
        vscode.window.setStatusBarMessage('Cleared saved Claude sessions', 3000);
      }
    })
  );

  context.subscriptions.push({ dispose: () => manager.dispose() });
}

async function maybeRestore(manager: SessionManager): Promise<void> {
  const persisted = manager.getPersisted();
  if (persisted.length === 0) return;
  if (manager.list().length > 0) return;

  const mode = vscode.workspace
    .getConfiguration('claudeCodeManager')
    .get<string>('restoreOnActivate', 'ask');

  if (mode === 'never') return;
  if (mode === 'always') {
    manager.restorePersisted();
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Restore ${persisted.length} Claude session(s) from your last workspace?`,
    'Restore',
    'Discard'
  );
  if (choice === 'Restore') {
    manager.restorePersisted();
  } else if (choice === 'Discard') {
    await manager.clearPersisted();
  }
}

export function deactivate(): void {
  // Subscriptions handle teardown.
}

function lastSegment(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
