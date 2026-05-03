import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

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

export interface PersistedSession {
  name: string;
  cwd: string;
  manuallyRenamed?: boolean;
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
  terminal: vscode.Terminal;
  startedAt: Date;
  status: SessionStatus;
  /**
   * Path to the JSONL log Claude Code is writing for this session, once
   * the detector has claimed one. Undefined until then.
   */
  jsonlPath?: string;
  /**
   * True once the user has manually renamed via `rename()`. Pins the name —
   * subsequent `ai-title` events from the JSONL detector will be ignored.
   */
  manuallyRenamed: boolean;
  usage: SessionUsage;
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
          if (session.terminal === terminal) {
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
  } = {}): ClaudeSession {
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

    const session: ClaudeSession = {
      id,
      name,
      cwd,
      terminal,
      startedAt: new Date(),
      status: 'idle',
      manuallyRenamed: false,
      usage: emptyUsage(),
      jsonlPath: knownJsonlPath,
    };
    this.sessions.set(id, session);
    this.persist();
    this._onDidChange.fire();
    return session;
  }

  focus(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.terminal.show(false);
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

  async kill(id: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (opts.confirm) {
      const choice = await vscode.window.showWarningMessage(
        `Kill Claude session "${session.name}"?`,
        { modal: true },
        'Kill'
      );
      if (choice !== 'Kill') return false;
    }

    session.terminal.dispose();
    this.sessions.delete(id);
    this.persist();
    this._onDidChange.fire();
    return true;
  }

  async killAll(opts: { confirm?: boolean } = {}): Promise<number> {
    if (this.sessions.size === 0) return 0;
    if (opts.confirm) {
      const choice = await vscode.window.showWarningMessage(
        `Kill all ${this.sessions.size} Claude session(s)?`,
        { modal: true },
        'Kill All'
      );
      if (choice !== 'Kill All') return 0;
    }
    const count = this.sessions.size;
    for (const session of this.sessions.values()) {
      session.terminal.dispose();
    }
    this.sessions.clear();
    this.persist();
    this._onDidChange.fire();
    return count;
  }

  sendPrompt(id: string, prompt: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.terminal.show(false);
    session.terminal.sendText(prompt, true);
  }

  dispose(): void {
    // Persistence already reflects the live set from prior persist() calls;
    // we deliberately do NOT clear it here so sessions can be restored next launch.
    this.disposing = true;
    for (const session of this.sessions.values()) {
      session.terminal.dispose();
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
   * Spawn a fresh session for each persisted record. Returns the number created.
   * Skips records whose cwd duplicates an already-running session to avoid noise.
   */
  restorePersisted(): number {
    const records = this.getPersisted();
    const liveCwds = new Set(Array.from(this.sessions.values()).map((s) => s.cwd));
    let created = 0;
    for (const r of records) {
      if (liveCwds.has(r.cwd)) continue;
      const session = this.create({ name: r.name, cwd: r.cwd });
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
