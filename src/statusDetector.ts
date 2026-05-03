import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { SessionManager, ClaudeSession, SessionStatus } from './sessionManager';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// How long to wait while in `busy` (assistant tool_use, no follow-up) before
// escalating to `permission`. Long-running tools (Bash, etc.) may briefly look
// like permission waits — the user can flip back manually.
const PERMISSION_THRESHOLD_MS = 10_000;

// `done` is set briefly when an assistant turn ends. If the matching
// `system.stop_hook_summary` doesn't arrive (no hooks configured), fade to
// `idle` after this delay so the pill doesn't get stuck on Done.
const DONE_FADE_MS = 4_000;

// Polling interval for "has the JSONL appeared yet" before tailing kicks in.
const DIR_POLL_MS = 1_000;

interface SessionWatch {
  session: ClaudeSession;
  cwdDir: string;
  /**
   * JSONL filenames present at attach time. Anything new in the dir is
   * assumed to belong to this session (with the more-recent file winning
   * if multiple appear at once).
   */
  knownFiles: Set<string>;
  jsonlPath?: string;
  byteOffset: number;
  buffer: string;
  dirPollTimer?: NodeJS.Timeout;
  fileWatcher?: fs.FSWatcher;
  filePollTimer?: NodeJS.Timeout;
  permissionTimer?: NodeJS.Timeout;
  doneFadeTimer?: NodeJS.Timeout;
  reading: boolean;
  pendingRead: boolean;
}

export class StatusDetector implements vscode.Disposable {
  private watches = new Map<string, SessionWatch>();
  private subscription: vscode.Disposable;
  private configSubscription: vscode.Disposable;

  constructor(private manager: SessionManager) {
    this.subscription = manager.onDidChange(() => this.sync());
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeManager.autoStatus.enabled')) {
        this.sync();
      }
    });
    setImmediate(() => this.sync());
  }

  dispose(): void {
    this.subscription.dispose();
    this.configSubscription.dispose();
    for (const id of Array.from(this.watches.keys())) this.detach(id);
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('autoStatus.enabled', true);
  }

  private autoRenameEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('claudeCodeManager')
      .get<boolean>('autoRename.enabled', true);
  }

  private sync(): void {
    if (!this.enabled()) {
      for (const id of Array.from(this.watches.keys())) this.detach(id);
      return;
    }
    const live = new Set(this.manager.list().map((s) => s.id));
    for (const id of Array.from(this.watches.keys())) {
      if (!live.has(id)) this.detach(id);
    }
    for (const session of this.manager.list()) {
      if (!this.watches.has(session.id)) void this.attach(session);
    }
  }

  private async attach(session: ClaudeSession): Promise<void> {
    const cwdDir = path.join(PROJECTS_DIR, encodeCwd(session.cwd));
    const knownFiles = await listJsonl(cwdDir);
    const watch: SessionWatch = {
      session,
      cwdDir,
      knownFiles,
      byteOffset: 0,
      buffer: '',
      reading: false,
      pendingRead: false,
    };
    this.watches.set(session.id, watch);
    if (session.jsonlPath) {
      // Resumed session — file already exists, skip dir-polling.
      watch.jsonlPath = session.jsonlPath;
      await this.beginTail(watch);
    } else {
      this.beginPolling(watch);
    }
  }

  private detach(id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    if (watch.dirPollTimer) clearInterval(watch.dirPollTimer);
    if (watch.fileWatcher) {
      try { watch.fileWatcher.close(); } catch { /* already closed */ }
    }
    if (watch.filePollTimer) clearInterval(watch.filePollTimer);
    if (watch.permissionTimer) clearTimeout(watch.permissionTimer);
    if (watch.doneFadeTimer) clearTimeout(watch.doneFadeTimer);
    this.watches.delete(id);
  }

  private beginPolling(watch: SessionWatch): void {
    const tryClaim = async () => {
      const current = await listJsonl(watch.cwdDir);
      const newOnes: string[] = [];
      for (const f of current) {
        if (!watch.knownFiles.has(f)) newOnes.push(f);
      }
      if (newOnes.length === 0) return;
      // Pick the most-recently-modified new file as ours.
      let claimedFile = newOnes[0];
      let claimedMtime = 0;
      for (const f of newOnes) {
        try {
          const stat = await fsp.stat(path.join(watch.cwdDir, f));
          if (stat.mtimeMs > claimedMtime) {
            claimedMtime = stat.mtimeMs;
            claimedFile = f;
          }
        } catch {
          // Ignore stat failures; file may have been deleted in the race.
        }
      }
      watch.jsonlPath = path.join(watch.cwdDir, claimedFile);
      this.manager.setJsonlPath(watch.session.id, watch.jsonlPath);
      if (watch.dirPollTimer) {
        clearInterval(watch.dirPollTimer);
        watch.dirPollTimer = undefined;
      }
      await this.beginTail(watch);
    };
    watch.dirPollTimer = setInterval(() => void tryClaim(), DIR_POLL_MS);
    void tryClaim();
  }

  private async beginTail(watch: SessionWatch): Promise<void> {
    if (!watch.jsonlPath) return;
    // First read processes everything written so far (Claude Code typically
    // writes a few events before we get here).
    await this.readNew(watch);
    try {
      watch.fileWatcher = fs.watch(watch.jsonlPath, () => {
        void this.readNew(watch);
      });
    } catch {
      // Some platforms (notably some FUSE mounts) don't support fs.watch
      // reliably. Fall back to polling.
      watch.filePollTimer = setInterval(() => void this.readNew(watch), 500);
    }
  }

  private async readNew(watch: SessionWatch): Promise<void> {
    if (!watch.jsonlPath) return;
    // Coalesce concurrent reads — fs.watch can fire multiple times rapidly.
    if (watch.reading) {
      watch.pendingRead = true;
      return;
    }
    watch.reading = true;
    try {
      do {
        watch.pendingRead = false;
        const stat = await fsp.stat(watch.jsonlPath).catch(() => null);
        if (!stat) {
          // File deleted/rotated. Stop tailing.
          if (watch.fileWatcher) {
            try { watch.fileWatcher.close(); } catch { /* noop */ }
            watch.fileWatcher = undefined;
          }
          if (watch.filePollTimer) {
            clearInterval(watch.filePollTimer);
            watch.filePollTimer = undefined;
          }
          return;
        }
        if (stat.size < watch.byteOffset) {
          // File was truncated or rotated. Restart from byte 0.
          watch.byteOffset = 0;
          watch.buffer = '';
        }
        if (stat.size <= watch.byteOffset) continue;
        const len = stat.size - watch.byteOffset;
        const fd = await fsp.open(watch.jsonlPath, 'r');
        try {
          const buf = Buffer.alloc(len);
          await fd.read(buf, 0, len, watch.byteOffset);
          watch.byteOffset = stat.size;
          const chunk = watch.buffer + buf.toString('utf8');
          const lines = chunk.split('\n');
          watch.buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            this.processEvent(watch, event as JsonlEvent);
          }
        } finally {
          await fd.close();
        }
      } while (watch.pendingRead);
    } finally {
      watch.reading = false;
    }
  }

  private processEvent(watch: SessionWatch, event: JsonlEvent): void {
    switch (event.type) {
      case 'ai-title':
        if (typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
          if (this.autoRenameEnabled()) {
            this.manager.autoRename(watch.session.id, event.aiTitle.trim());
          }
        }
        break;

      case 'user':
        this.setStatus(watch, 'busy');
        break;

      case 'assistant': {
        const msg = event.message ?? {};
        const stopReason = msg.stop_reason;
        const content = Array.isArray(msg.content) ? msg.content : [];
        const hasAskQuestion = content.some(
          (c) => c && typeof c === 'object' && c.type === 'tool_use' && c.name === 'AskUserQuestion'
        );
        if (hasAskQuestion) {
          this.setStatus(watch, 'question');
        } else if (stopReason === 'end_turn') {
          this.setStatus(watch, 'done');
          this.queueDoneFade(watch);
        } else if (stopReason === 'tool_use') {
          this.setStatus(watch, 'busy');
          this.queuePermissionEscalation(watch);
        } else {
          this.setStatus(watch, 'busy');
        }
        if (msg.usage) {
          const u = msg.usage;
          const cw = u.cache_creation;
          this.manager.addUsage(watch.session.id, {
            model: msg.model,
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens,
            cacheWrite5mTokens: cw?.ephemeral_5m_input_tokens,
            cacheWrite1hTokens: cw?.ephemeral_1h_input_tokens,
          });
        }
        break;
      }

      case 'system':
        if (event.subtype === 'stop_hook_summary') {
          this.setStatus(watch, 'idle');
        }
        break;

      // ai-title handled above; everything else (queue-operation,
      // file-history-snapshot, attachment, last-prompt) is metadata we ignore.
    }
  }

  private setStatus(watch: SessionWatch, status: SessionStatus): void {
    if (watch.permissionTimer) {
      clearTimeout(watch.permissionTimer);
      watch.permissionTimer = undefined;
    }
    if (status !== 'done' && watch.doneFadeTimer) {
      clearTimeout(watch.doneFadeTimer);
      watch.doneFadeTimer = undefined;
    }
    this.manager.setStatus(watch.session.id, status);
  }

  private queueDoneFade(watch: SessionWatch): void {
    if (watch.doneFadeTimer) clearTimeout(watch.doneFadeTimer);
    watch.doneFadeTimer = setTimeout(() => {
      watch.doneFadeTimer = undefined;
      const s = this.manager.get(watch.session.id);
      if (s?.status === 'done') {
        this.manager.setStatus(watch.session.id, 'idle');
      }
    }, DONE_FADE_MS);
  }

  private queuePermissionEscalation(watch: SessionWatch): void {
    if (watch.permissionTimer) clearTimeout(watch.permissionTimer);
    watch.permissionTimer = setTimeout(() => {
      watch.permissionTimer = undefined;
      const s = this.manager.get(watch.session.id);
      if (s?.status === 'busy') {
        this.manager.setStatus(watch.session.id, 'permission');
      }
    }, PERMISSION_THRESHOLD_MS);
  }
}

interface JsonlEvent {
  type?: string;
  aiTitle?: string;
  subtype?: string;
  message?: {
    model?: string;
    stop_reason?: string;
    content?: Array<{ type?: string; name?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

async function listJsonl(dir: string): Promise<Set<string>> {
  try {
    const entries = await fsp.readdir(dir);
    return new Set(entries.filter((e) => e.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}
