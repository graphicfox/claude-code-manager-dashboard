import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  SessionManager,
  SessionStatus,
  SessionUsage,
  SessionKind,
  ClaudeSession,
} from './sessionManager';

export const MANIFESTS_DIR = path.join(
  os.homedir(),
  '.claude',
  'claude-code-manager',
  'windows'
);

const HEARTBEAT_MS = 5_000;

export interface WindowManifest {
  version: 1;
  windowId: string;
  lastUpdated: string;
  /**
   * The first workspace folder of the window, if any. Other windows use this
   * to bring the right VS Code window forward via `code <folder>` — `osascript
   * activate` alone always foregrounds the most-recent window, which would be
   * the clicker's window, not the target.
   */
  workspaceFolder?: string;
  /**
   * `vscode.workspace.name` — for `.code-workspace` files this is the
   * workspace's user-visible name (e.g. "Siteflow-Next"); for single-folder
   * windows this is the folder basename. Used to find the window by title
   * since VS Code's default title format includes `${rootName}` = this.
   */
  workspaceName?: string;
  sessions: ManifestSession[];
}

export interface ManifestSession {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  startedAt: string;
  jsonlPath?: string;
  manuallyRenamed: boolean;
  usage: SessionUsage;
  /** Defaults to 'cli' for manifests that pre-date the field. */
  kind?: SessionKind;
}

/**
 * Publishes this window's session list to a JSON file under
 * `~/.claude/claude-code-manager/windows/<pid>.json` so other VS Code
 * windows can see what's running here. Writes atomically (tmp + rename)
 * on every session change and via a 5s heartbeat to keep `lastUpdated`
 * fresh while idle.
 */
export class ManifestPublisher implements vscode.Disposable {
  private readonly id: string;
  private readonly filePath: string;
  private readonly tmpPath: string;
  private heartbeat: NodeJS.Timeout | undefined;
  private subscriptions: vscode.Disposable[] = [];
  private writing = false;
  private pendingWrite = false;
  private disposed = false;

  constructor(private manager: SessionManager) {
    this.id = String(process.pid);
    this.filePath = path.join(MANIFESTS_DIR, `${this.id}.json`);
    this.tmpPath = path.join(MANIFESTS_DIR, `${this.id}.json.tmp`);
    this.subscriptions.push(manager.onDidChange(() => void this.write()));
    this.subscriptions.push(manager.onDidChangeStatus(() => void this.write()));
    this.heartbeat = setInterval(() => void this.write(), HEARTBEAT_MS);
    void this.write();
  }

  windowId(): string {
    return this.id;
  }

  dispose(): void {
    this.disposed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    while (this.subscriptions.length) {
      const d = this.subscriptions.pop();
      if (d) d.dispose();
    }
    // Best-effort: remove our own manifest synchronously-ish so other
    // windows see us disappear immediately. Failures are silent.
    void fs.unlink(this.filePath).catch(() => undefined);
    void fs.unlink(this.tmpPath).catch(() => undefined);
  }

  private async write(): Promise<void> {
    if (this.disposed) return;
    // Coalesce concurrent writes: a heartbeat tick mid-write becomes one
    // follow-up write, not a queue of them.
    if (this.writing) {
      this.pendingWrite = true;
      return;
    }
    this.writing = true;
    try {
      do {
        this.pendingWrite = false;
        const manifest: WindowManifest = {
          version: 1,
          windowId: this.id,
          lastUpdated: new Date().toISOString(),
          workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          workspaceName: vscode.workspace.name,
          sessions: this.manager.list().map(toManifestSession),
        };
        try {
          await fs.mkdir(MANIFESTS_DIR, { recursive: true });
          await fs.writeFile(this.tmpPath, JSON.stringify(manifest));
          await fs.rename(this.tmpPath, this.filePath);
        } catch {
          // Disk full / permission denied / EROFS — silently disable.
          // Try again on the next event or heartbeat.
        }
      } while (this.pendingWrite && !this.disposed);
    } finally {
      this.writing = false;
    }
  }
}

function toManifestSession(s: ClaudeSession): ManifestSession {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    status: s.status,
    startedAt: s.startedAt.toISOString(),
    jsonlPath: s.jsonlPath,
    manuallyRenamed: s.manuallyRenamed,
    usage: s.usage,
    kind: s.kind,
  };
}
