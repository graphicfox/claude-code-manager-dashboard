import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { hostUriScheme } from './host';

const PERSIST_KEY = 'claudeCodeManager.sessions.v1';
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export type SessionStatus =
  | 'idle'
  | 'busy'
  | 'question'
  | 'permission'
  | 'done'
  | 'exited';

export const STATUS_ORDER: SessionStatus[] = [
  'idle',
  'busy',
  'question',
  'permission',
  'done',
];

/**
 * What kind of session this manager record represents.
 *
 * - `cli` — spawned by us as a `claude` CLI process inside a `vscode.Terminal`
 *   that we own. Full control: focus, kill, sendPrompt, JSONL auto-status.
 * - `extension` — a "shadow" entry pointing at a tab in the official
 *   `anthropic.claude-code` extension. We open it via the host editor's URI
 *   handler and walk away; the official extension owns the lifecycle.
 *   Limited actions: rename, set status, remove from list. See design log
 *   #05 and #06.
 */
export type SessionKind = 'cli' | 'extension';

export interface PersistedSession {
  name: string;
  cwd: string;
  manuallyRenamed?: boolean;
  /** Defaults to 'cli' for legacy records that pre-date the field. */
  kind?: SessionKind;
  /**
   * For `kind: 'extension'`, the JSONL session id captured by the detector
   * after the official extension started writing logs for this tab. On
   * restore, used as `?session=<id>` to resume the actual conversation.
   */
  extensionSessionId?: string;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** USD estimate based on the model's published rates; 0 if model unknown. */
  costUsd: number;
}

export interface ClaudeSession {
  id: string;
  name: string;
  cwd: string;
  kind: SessionKind;
  /** Only present when `kind === 'cli'`. Extension shadows have no terminal. */
  terminal: vscode.Terminal | undefined;
  startedAt: Date;
  status: SessionStatus;
  /**
   * Path to the JSONL log Claude Code is writing for this session, once
   * the detector has claimed one. Undefined until then.
   */
  jsonlPath?: string;
  /**
   * For `kind: 'extension'`, the JSONL session id captured by the detector
   * once the official extension started writing logs for this tab. Undefined
   * until claimed. Used to resume via `?session=<id>` on reload and to focus
   * an existing tab via the same URI.
   */
  extensionSessionId?: string;
  /**
   * True once the user has manually renamed via `rename()`. Pins the name —
   * subsequent `ai-title` events from the JSONL detector will be ignored.
   */
  manuallyRenamed: boolean;
  usage: SessionUsage;
  /**
   * Last time this session showed any sign of life — JSONL grew, terminal
   * was active, etc. Initialized to `startedAt`. Used by the lifecycle
   * monitor to flip stale sessions to `exited`.
   */
  lastActivityAt: Date;
}

export interface SessionStatusChange {
  id: string;
  from: SessionStatus;
  to: SessionStatus;
}

const NAME_ADJECTIVES = [
  'fuzzy', 'brave', 'silent', 'eager', 'curious', 'clever', 'gentle',
  'mighty', 'swift', 'quiet', 'lucky', 'witty', 'jolly', 'sleepy',
  'sneaky', 'cosmic', 'lunar', 'sunny', 'misty', 'frosty', 'amber',
  'velvet', 'glowing', 'wandering', 'dreaming',
];

const NAME_ANIMALS = [
  'dragon', 'fox', 'otter', 'falcon', 'lynx', 'panda', 'badger',
  'wolf', 'tiger', 'koala', 'raven', 'heron', 'bison', 'orca',
  'gecko', 'phoenix', 'owl', 'puffin', 'narwhal', 'hedgehog',
  'capybara', 'mantis', 'salamander', 'whale', 'fennec',
];

function randomName(): string {
  const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const animal = NAME_ANIMALS[Math.floor(Math.random() * NAME_ANIMALS.length)];
  return `${adj}-${animal}`;
}

/**
 * Manages the lifecycle of Claude Code CLI sessions, each backed by a
 * dedicated VS Code integrated terminal.
 */
export class SessionManager {
  private sessions = new Map<string, ClaudeSession>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _onDidChangeStatus = new vscode.EventEmitter<SessionStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;
  private disposing = false;

  constructor(private context: vscode.ExtensionContext) {
    // Detect external terminal closures so our state stays in sync.
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.disposing) return;
        for (const [id, session] of this.sessions) {
          if (session.kind === 'cli' && session.terminal === terminal) {
            session.status = 'exited';
            this.sessions.delete(id);
            this.persist();
            this._onDidChange.fire();
            break;
          }
        }
      })
    );
  }

  list(): ClaudeSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime()
    );
  }

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id);
  }

  create(opts: {
    name?: string;
    cwd?: string;
    extraArgs?: string[];
    /** If set, spawns with `--resume <id>` to continue a prior conversation. */
    resumeSessionId?: string;
    /** Override the default kind from `claudeCodeManager.sessionType`. */
    kind?: SessionKind;
  } = {}): ClaudeSession {
    const config = vscode.workspace.getConfiguration('claudeCodeManager');
    const configured = config.get<string>('sessionType', 'terminal');
    const kind: SessionKind = opts.kind
      ?? (configured === 'extension' ? 'extension' : 'cli');

    if (kind === 'extension') return this.createExtensionShadow(opts);
    return this.createCli(opts);
  }

  private createCli(opts: {
    name?: string;
    cwd?: string;
    extraArgs?: string[];
    resumeSessionId?: string;
  }): ClaudeSession {
    const config = vscode.workspace.getConfiguration('claudeCodeManager');
    const cliPath = config.get<string>('cliPath', 'claude');
    const defaultArgs = config.get<string[]>('defaultArgs', []);
    const shell = config.get<string>('shell', '') || undefined;

    const cwd = opts.cwd ?? this.defaultCwd();
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = opts.name ?? this.suggestName(cwd);

    const resumeArgs = opts.resumeSessionId
      ? ['--resume', opts.resumeSessionId]
      : [];
    const args = [...defaultArgs, ...resumeArgs, ...(opts.extraArgs ?? [])];
    const commandLine = this.buildCommandLine(cliPath, args);

    // For resumes, we already know the JSONL path: ~/.claude/projects/<encoded-cwd>/<id>.jsonl.
    // Pre-set so the detector doesn't have to poll for a "new" file (the existing file is reused).
    const knownJsonlPath = opts.resumeSessionId
      ? this.jsonlPathFor(cwd, opts.resumeSessionId)
      : undefined;

    const terminal = vscode.window.createTerminal({
      name: `Claude: ${name}`,
      cwd,
      shellPath: shell,
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
    terminal.sendText(commandLine, true);
    terminal.show();

    const now = new Date();
    const session: ClaudeSession = {
      id,
      name,
      cwd,
      kind: 'cli',
      terminal,
      startedAt: now,
      status: 'idle',
      manuallyRenamed: false,
      usage: emptyUsage(),
      jsonlPath: knownJsonlPath,
      lastActivityAt: now,
    };
    this.sessions.set(id, session);
    this.persist();
    this._onDidChange.fire();
    return session;
  }

  /**
   * Open a tab in the official `anthropic.claude-code` extension via its
   * documented URI handler, and track a shadow entry here. We don't own
   * the lifecycle — the user closes the tab themselves.
   *
   * The URI scheme is read from the host (`vscode://` in VS Code,
   * `antigravity-ide://` in Antigravity, etc.) so the OS routes the request
   * back to the host that's actually running us, instead of waking up
   * whichever editor happens to own the `vscode://` registration.
   */
  private createExtensionShadow(opts: {
    name?: string;
    cwd?: string;
    resumeSessionId?: string;
  }): ClaudeSession {
    const cwd = opts.cwd ?? this.defaultCwd();
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = opts.name ?? this.suggestName(cwd);

    const params = opts.resumeSessionId
      ? `?session=${encodeURIComponent(opts.resumeSessionId)}`
      : '';
    const uri = vscode.Uri.parse(
      `${hostUriScheme()}://anthropic.claude-code/open${params}`
    );
    void vscode.env.openExternal(uri);

    // For resumes the JSONL file already exists; pre-seed the path so the
    // detector tails it directly instead of waiting for a "new" file.
    const knownJsonlPath = opts.resumeSessionId
      ? this.jsonlPathFor(cwd, opts.resumeSessionId)
      : undefined;

    const now = new Date();
    const session: ClaudeSession = {
      id,
      name,
      cwd,
      kind: 'extension',
      terminal: undefined,
      startedAt: now,
      status: 'idle',
      manuallyRenamed: false,
      usage: emptyUsage(),
      jsonlPath: knownJsonlPath,
      extensionSessionId: opts.resumeSessionId,
      lastActivityAt: now,
    };
    this.sessions.set(id, session);
    this.persist();
    this._onDidChange.fire();
    return session;
  }

  /**
   * Adopt a Claude Code session started outside of this manager (e.g. via the
   * official extension's own UI, or a bare `claude` CLI). The detector picks
   * up the JSONL feed immediately since `jsonlPath` is pre-set. Used by
   * AutoDiscovery; does not fire the URI handler.
   */
  importExtensionSession(opts: {
    cwd: string;
    name?: string;
    extensionSessionId: string;
    jsonlPath: string;
    startedAt?: Date;
  }): ClaudeSession {
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = opts.name ?? this.suggestName(opts.cwd);
    const startedAt = opts.startedAt ?? new Date();
    const session: ClaudeSession = {
      id,
      name,
      cwd: opts.cwd,
      kind: 'extension',
      terminal: undefined,
      startedAt,
      status: 'idle',
      manuallyRenamed: false,
      usage: emptyUsage(),
      jsonlPath: opts.jsonlPath,
      extensionSessionId: opts.extensionSessionId,
      lastActivityAt: new Date(),
    };
    this.sessions.set(id, session);
    this.persist();
    this._onDidChange.fire();
    return session;
  }

  focus(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.kind === 'cli') {
      session.terminal?.show(false);
      return;
    }
    // Extension shadow. If we know the JSONL session id, fire the URI
    // handler with `?session=<id>` — per the official docs, that focuses
    // an already-open tab or re-opens the prior conversation. Without the
    // id we'd open a fresh tab, which is misleading.
    if (session.extensionSessionId) {
      const uri = vscode.Uri.parse(
        `${hostUriScheme()}://anthropic.claude-code/open?session=${encodeURIComponent(session.extensionSessionId)}`
      );
      void vscode.env.openExternal(uri);
      return;
    }
    vscode.window.setStatusBarMessage(
      `"${session.name}" hasn't been claimed yet — send a prompt in its tab so the manager can capture its session id.`,
      4000
    );
  }

  setStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.status === status) return;
    const from = session.status;
    session.status = status;
    this._onDidChangeStatus.fire({ id, from, to: status });
    this._onDidChange.fire();
    // status is ephemeral, not persisted
  }

  /**
   * Detector calls this whenever a session's JSONL grows. No event fire —
   * a hot path for every read; the lifecycle monitor reads the field
   * directly on its periodic tick.
   */
  bumpActivity(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastActivityAt = new Date();
  }

  /**
   * Mark a session as `exited` without removing it from the list. Used by
   * the lifecycle monitor when the JSONL has been quiet too long or the
   * Claude Code tab was closed.
   */
  markExited(id: string): void {
    this.setStatus(id, 'exited');
  }

  /**
   * Drop every session currently in the `exited` state. Returns the count
   * that was removed.
   */
  clearClosed(): number {
    let count = 0;
    for (const [id, s] of Array.from(this.sessions.entries())) {
      if (s.status !== 'exited') continue;
      if (s.kind === 'cli' && s.terminal) {
        // Defensive: terminal should already be disposed in this state.
        s.terminal.dispose();
      }
      this.sessions.delete(id);
      count++;
    }
    if (count > 0) {
      this.persist();
      this._onDidChange.fire();
    }
    return count;
  }

  /**
   * Add a usage delta from a single assistant message. The caller (status
   * detector) extracts `message.usage` and `message.model` from a JSONL line
   * and forwards them here. Cost is computed against `MODEL_PRICING` and
   * accumulated. Unknown models contribute 0 to cost but still tally tokens.
   */
  addUsage(
    id: string,
    delta: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWrite5mTokens?: number;
      cacheWrite1hTokens?: number;
    }
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const u = session.usage;
    u.inputTokens += delta.inputTokens ?? 0;
    u.outputTokens += delta.outputTokens ?? 0;
    u.cacheReadTokens += delta.cacheReadTokens ?? 0;
    u.cacheWrite5mTokens += delta.cacheWrite5mTokens ?? 0;
    u.cacheWrite1hTokens += delta.cacheWrite1hTokens ?? 0;
    u.costUsd += estimateCostUsd(delta);
    this._onDidChange.fire();
  }

  rename(id: string, newName: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.name = newName;
    session.manuallyRenamed = true;
    // VS Code doesn't expose terminal renaming via API directly, but the
    // tree label will update on next refresh.
    this.persist();
    this._onDidChange.fire();
  }

  /**
   * Apply a name derived from a Claude Code `ai-title` event. Skipped when
   * the user has manually renamed (pinned) or the proposed name is unchanged.
   */
  autoRename(id: string, newName: string): void {
    const session = this.sessions.get(id);
    if (!session || session.manuallyRenamed) return;
    if (session.name === newName) return;
    session.name = newName;
    this.persist();
    this._onDidChange.fire();
  }

  /**
   * Internal: detector calls this when it claims a JSONL file for a session.
   */
  setJsonlPath(id: string, jsonlPath: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.jsonlPath = jsonlPath;
    // No event fire — purely internal bookkeeping.
  }

  /**
   * Internal: detector calls this once it has claimed a JSONL file for an
   * extension shadow. Persists so the id survives across reloads.
   */
  setExtensionSessionId(id: string, extensionSessionId: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.extensionSessionId === extensionSessionId) return;
    session.extensionSessionId = extensionSessionId;
    this.persist();
    // No onDidChange fire — UI doesn't render this directly.
  }

  async kill(id: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    const isShadow = session.kind === 'extension';
    if (opts.confirm) {
      const verb = isShadow ? 'Remove' : 'Kill';
      const message = isShadow
        ? `Remove "${session.name}" from the list? The Claude Code extension's tab will not be closed.`
        : `Kill Claude session "${session.name}"?`;
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        verb
      );
      if (choice !== verb) return false;
    }

    if (session.kind === 'cli' && session.terminal) {
      session.terminal.dispose();
    }
    this.sessions.delete(id);
    this.persist();
    this._onDidChange.fire();
    return true;
  }

  async killAll(opts: { confirm?: boolean } = {}): Promise<number> {
    if (this.sessions.size === 0) return 0;
    if (opts.confirm) {
      const choice = await vscode.window.showWarningMessage(
        `Kill all ${this.sessions.size} Claude session(s)? Extension tabs will not be closed; their entries will just be removed from the list.`,
        { modal: true },
        'Kill All'
      );
      if (choice !== 'Kill All') return 0;
    }
    const count = this.sessions.size;
    for (const session of this.sessions.values()) {
      if (session.kind === 'cli' && session.terminal) {
        session.terminal.dispose();
      }
    }
    this.sessions.clear();
    this.persist();
    this._onDidChange.fire();
    return count;
  }

  sendPrompt(id: string, prompt: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.kind !== 'cli' || !session.terminal) {
      vscode.window.setStatusBarMessage(
        `"${session.name}" is owned by the Claude Code extension — type prompts in its tab directly.`,
        4000
      );
      return;
    }
    session.terminal.show(false);
    session.terminal.sendText(prompt, true);
  }

  dispose(): void {
    // Persistence already reflects the live set from prior persist() calls;
    // we deliberately do NOT clear it here so sessions can be restored next launch.
    this.disposing = true;
    for (const session of this.sessions.values()) {
      if (session.kind === 'cli' && session.terminal) {
        session.terminal.dispose();
      }
    }
    this.sessions.clear();
    this._onDidChange.dispose();
    this._onDidChangeStatus.dispose();
  }

  // --- persistence -------------------------------------------------------

  getPersisted(): PersistedSession[] {
    return this.context.workspaceState.get<PersistedSession[]>(PERSIST_KEY, []);
  }

  async clearPersisted(): Promise<void> {
    await this.context.workspaceState.update(PERSIST_KEY, []);
  }

  /**
   * Spawn / re-open a fresh session for each persisted record. Returns the
   * number created. Skips records whose cwd duplicates an already-running
   * CLI session to avoid noise.
   *
   * For `kind: 'extension'` records the URI handler is fired with
   * `?session=<extensionSessionId>` so the official extension resumes the
   * prior conversation if it can find the JSONL log; falls back to a fresh
   * tab if the id isn't known. See design log #05.
   */
  restorePersisted(): number {
    const records = this.getPersisted();
    const liveCwds = new Set(Array.from(this.sessions.values()).map((s) => s.cwd));
    let created = 0;
    for (const r of records) {
      const recKind: SessionKind = r.kind ?? 'cli';
      if (recKind === 'cli' && liveCwds.has(r.cwd)) continue;
      const session = this.create({
        name: r.name,
        cwd: r.cwd,
        kind: recKind,
        resumeSessionId: recKind === 'extension' ? r.extensionSessionId : undefined,
      });
      if (r.manuallyRenamed) session.manuallyRenamed = true;
      created++;
    }
    return created;
  }

  private persist(): void {
    const records: PersistedSession[] = Array.from(this.sessions.values()).map((s) => ({
      name: s.name,
      cwd: s.cwd,
      manuallyRenamed: s.manuallyRenamed || undefined,
      kind: s.kind,
      extensionSessionId: s.kind === 'extension' ? s.extensionSessionId : undefined,
    }));
    this.context.workspaceState.update(PERSIST_KEY, records);
  }

  // --- helpers -----------------------------------------------------------

  private defaultCwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri.fsPath;
    return process.env.HOME || process.cwd();
  }

  private suggestName(_cwd: string): string {
    const taken = new Set(Array.from(this.sessions.values()).map((s) => s.name));
    for (let i = 0; i < 50; i++) {
      const candidate = randomName();
      if (!taken.has(candidate)) return candidate;
    }
    // Fallback if 50 attempts collide (vanishingly unlikely with ~625 combos)
    return `${randomName()}-${Date.now().toString(36).slice(-3)}`;
  }

  private buildCommandLine(cli: string, args: string[]): string {
    const quoted = [cli, ...args].map((part) =>
      /\s/.test(part) ? JSON.stringify(part) : part
    );
    return quoted.join(' ');
  }

  private jsonlPathFor(cwd: string, sessionId: string): string {
    return path.join(PROJECTS_DIR, cwd.replace(/[/\\]/g, '-'), `${sessionId}.jsonl`);
  }
}

function emptyUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    costUsd: 0,
  };
}

interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
}

/**
 * Approximate USD-per-1M-tokens pricing for the Claude 4.x family. Cache
 * read is treated as 0.1x input; 5-minute cache write as 1.25x input;
 * 1-hour cache write as 2x input. Pricing changes — these are rough cost
 * estimates, not invoices.
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': { inputPerMtok: 15, outputPerMtok: 75 },
  'claude-opus-4-6': { inputPerMtok: 15, outputPerMtok: 75 },
  'claude-opus-4-5': { inputPerMtok: 15, outputPerMtok: 75 },
  'claude-sonnet-4-6': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-sonnet-4-5': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-haiku-4-5': { inputPerMtok: 1, outputPerMtok: 5 },
};

function pricingFor(model: string | undefined): ModelPricing | undefined {
  if (!model) return undefined;
  // Match `claude-opus-4-7` from `claude-opus-4-7-20260101` etc.
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(key)) return MODEL_PRICING[key];
  }
  return undefined;
}

function estimateCostUsd(delta: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}): number {
  const p = pricingFor(delta.model);
  if (!p) return 0;
  const M = 1_000_000;
  const input = (delta.inputTokens ?? 0) * (p.inputPerMtok / M);
  const output = (delta.outputTokens ?? 0) * (p.outputPerMtok / M);
  const cacheRead = (delta.cacheReadTokens ?? 0) * (p.inputPerMtok * 0.1 / M);
  const cw5 = (delta.cacheWrite5mTokens ?? 0) * (p.inputPerMtok * 1.25 / M);
  const cw1h = (delta.cacheWrite1hTokens ?? 0) * (p.inputPerMtok * 2 / M);
  return input + output + cacheRead + cw5 + cw1h;
}
