import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  MANIFESTS_DIR,
  WindowManifest,
  ManifestSession,
} from './manifestPublisher';
import { SessionStatus, SessionUsage, SessionKind } from './sessionManager';

const FRESHNESS_TTL_MS = 30_000;
const SWEEP_TTL_MS = 120_000;
const POLL_FALLBACK_MS = 5_000;
const SWEEP_INTERVAL_MS = 60_000;
const READ_DEBOUNCE_MS = 100;

export interface ExternalSession {
  windowId: string;
  workspaceFolder?: string;
  workspaceName?: string;
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  startedAt: Date;
  jsonlPath?: string;
  manuallyRenamed: boolean;
  usage: SessionUsage;
  /** Defaults to 'cli' for manifests that pre-date the field. */
  kind?: SessionKind;
}

/**
 * Watches the per-window manifest directory and exposes a flat list of
 * sessions belonging to *other* VS Code windows on this machine. Honours
 * `claudeCodeManager.showAllWindows` — when off, returns an empty list and
 * stops watching.
 */
export class ExternalSessionTracker implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private current: ExternalSession[] = [];
  private snapshot = '[]';
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readDebounce: NodeJS.Timeout | undefined;
  private configSub: vscode.Disposable;
  private disposed = false;

  constructor(private readonly ownWindowId: string) {
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeManager.showAllWindows')) {
        if (this.enabled()) {
          this.start();
        } else {
          this.stopWatching();
          if (this.current.length) {
            this.current = [];
            this.snapshot = '[]';
            this._onDidChange.fire();
          }
        }
      }
    });
    if (this.enabled()) this.start();
  }

  list(): ExternalSession[] {
    return this.enabled() ? this.current : [];
  }

  dispose(): void {
    this.disposed = true;
    this.configSub.dispose();
    this.stopWatching();
    this._onDidChange.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('showAllWindows', true);
  }

  private start(): void {
    void this.refresh();
    this.beginWatching();
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweepStale(), SWEEP_INTERVAL_MS);
      void this.sweepStale();
    }
  }

  private beginWatching(): void {
    if (this.watcher || this.pollTimer) return;
    try {
      // Make sure the dir exists before watching, otherwise fs.watch throws.
      fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
      this.watcher = fs.watch(MANIFESTS_DIR, () => this.scheduleRefresh());
      this.watcher.on('error', () => {
        try { this.watcher?.close(); } catch { /* noop */ }
        this.watcher = undefined;
        this.beginPollingFallback();
      });
    } catch {
      this.beginPollingFallback();
    }
  }

  private beginPollingFallback(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), POLL_FALLBACK_MS);
  }

  private stopWatching(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.readDebounce) {
      clearTimeout(this.readDebounce);
      this.readDebounce = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.readDebounce) return;
    this.readDebounce = setTimeout(() => {
      this.readDebounce = undefined;
      void this.refresh();
    }, READ_DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const next = await readAll(this.ownWindowId);
    // Stable serialization for change detection. Status/usage flicker still
    // fires; pure heartbeat-only writes (where everything else is identical)
    // do not.
    const serialized = stableSerialize(next);
    if (serialized === this.snapshot) return;
    this.snapshot = serialized;
    this.current = next;
    this._onDidChange.fire();
  }

  private async sweepStale(): Promise<void> {
    if (this.disposed) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(MANIFESTS_DIR);
    } catch {
      return;
    }
    const now = Date.now();
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      if (file === `${this.ownWindowId}.json`) continue;
      const full = path.join(MANIFESTS_DIR, file);
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > SWEEP_TTL_MS) {
          await fsp.unlink(full).catch(() => undefined);
        }
      } catch {
        // file removed mid-iteration; ignore
      }
    }
  }
}

async function readAll(ownWindowId: string): Promise<ExternalSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(MANIFESTS_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const out: ExternalSession[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    if (file === `${ownWindowId}.json`) continue;
    const full = path.join(MANIFESTS_DIR, file);
    let manifest: WindowManifest | undefined;
    try {
      const raw = await fsp.readFile(full, 'utf8');
      manifest = JSON.parse(raw) as WindowManifest;
    } catch {
      continue;
    }
    if (!manifest || !manifest.windowId || manifest.windowId === ownWindowId) continue;
    if (!Array.isArray(manifest.sessions)) continue;
    const updated = Date.parse(manifest.lastUpdated);
    if (!Number.isFinite(updated) || now - updated > FRESHNESS_TTL_MS) continue;
    for (const s of manifest.sessions) {
      out.push(
        toExternal(manifest.windowId, manifest.workspaceFolder, manifest.workspaceName, s)
      );
    }
  }
  return out;
}

function toExternal(
  windowId: string,
  workspaceFolder: string | undefined,
  workspaceName: string | undefined,
  s: ManifestSession
): ExternalSession {
  return {
    windowId,
    workspaceFolder,
    workspaceName,
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    status: s.status,
    startedAt: new Date(s.startedAt),
    jsonlPath: s.jsonlPath,
    manuallyRenamed: !!s.manuallyRenamed,
    usage: s.usage,
    kind: s.kind ?? 'cli',
  };
}

function stableSerialize(list: ExternalSession[]): string {
  const sorted = [...list].sort((a, b) =>
    a.windowId === b.windowId ? a.id.localeCompare(b.id) : a.windowId.localeCompare(b.windowId)
  );
  return JSON.stringify(
    sorted.map((s) => ({
      windowId: s.windowId,
      workspaceFolder: s.workspaceFolder,
      workspaceName: s.workspaceName,
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      jsonlPath: s.jsonlPath,
      manuallyRenamed: s.manuallyRenamed,
      usage: s.usage,
      kind: s.kind,
    }))
  );
}
