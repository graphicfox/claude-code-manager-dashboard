import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Periodically scans `~/.claude/projects/<encoded-cwd>/` for JSONL files that
 * indicate a recently active Claude session not yet tracked by the manager.
 * Adopts each as an `extension` shadow so it shows up in the sidebar with
 * auto-status enabled.
 *
 * Scope: only the current workspace's first folder. Other windows are
 * already covered by `ExternalSessionTracker` (see design log #04).
 */
export class AutoDiscovery implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private configSub: vscode.Disposable;
  /**
   * Session ids whose card the user has explicitly removed; we don't
   * re-adopt them in subsequent ticks. Detected implicitly: anything that
   * was live on a previous tick and disappeared without us re-discovering
   * it counts as "user removed".
   */
  private ignored = new Set<string>();
  private lastLiveIds = new Set<string>();
  private disposed = false;

  constructor(private manager: SessionManager) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeManager.autoDiscovery')) {
        this.restart();
      }
    });
    this.restart();
  }

  dispose(): void {
    this.disposed = true;
    this.configSub.dispose();
    this.stop();
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('autoDiscovery.enabled', true);
  }

  private intervalMs(): number {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<number>('autoDiscovery.intervalMs', 10_000);
  }

  private freshnessMs(): number {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<number>('autoDiscovery.freshnessMs', 60_000);
  }

  private restart(): void {
    this.stop();
    if (this.disposed || !this.enabled()) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs());
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private currentCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0].uri.fsPath;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;

    const cwd = this.currentCwd();
    if (!cwd) return;
    const dir = path.join(PROJECTS_DIR, encodeCwd(cwd));

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }

    // Snapshot the manager's view so we can both detect newcomers and
    // notice when a previously-live session has been removed by the user.
    const liveExtIds = new Set<string>();
    const liveJsonls = new Set<string>();
    const liveCliCwds = new Set<string>();
    for (const s of this.manager.list()) {
      if (s.extensionSessionId) liveExtIds.add(s.extensionSessionId);
      if (s.jsonlPath) liveJsonls.add(s.jsonlPath);
      // Brand-new CLI sessions may not have claimed a JSONL yet; defer
      // adoption in their cwd to avoid racing with the detector.
      if (s.kind === 'cli' && !s.jsonlPath) liveCliCwds.add(s.cwd);
    }

    // Anything in lastLiveIds that's no longer live OR live-via-rediscovery
    // was killed by the user → ignore from now on.
    for (const id of this.lastLiveIds) {
      if (!liveExtIds.has(id)) this.ignored.add(id);
    }
    this.lastLiveIds = liveExtIds;

    if (liveCliCwds.has(cwd)) return;

    const now = Date.now();
    const fresh = this.freshnessMs();

    for (const file of entries) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace(/\.jsonl$/, '');
      if (liveExtIds.has(sessionId)) continue;
      if (this.ignored.has(sessionId)) continue;
      const full = path.join(dir, file);
      if (liveJsonls.has(full)) continue;

      let stat: import('fs').Stats;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > fresh) continue;

      const session = this.manager.importExtensionSession({
        cwd,
        extensionSessionId: sessionId,
        jsonlPath: full,
        startedAt: new Date(stat.birthtimeMs || stat.mtimeMs),
      });
      this.lastLiveIds.add(sessionId);
      vscode.window.setStatusBarMessage(
        `Discovered Claude session "${session.name}"`,
        3000
      );
    }
  }
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}
