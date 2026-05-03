import * as vscode from 'vscode';

const PERSIST_KEY = 'claudeCodeManager.sessions.v1';

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
}

export interface ClaudeSession {
  id: string;
  name: string;
  cwd: string;
  terminal: vscode.Terminal;
  startedAt: Date;
  status: SessionStatus;
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

  create(opts: { name?: string; cwd?: string; extraArgs?: string[] } = {}): ClaudeSession {
    const config = vscode.workspace.getConfiguration('claudeCodeManager');
    const cliPath = config.get<string>('cliPath', 'claude');
    const defaultArgs = config.get<string[]>('defaultArgs', []);
    const shell = config.get<string>('shell', '') || undefined;

    const cwd = opts.cwd ?? this.defaultCwd();
    const id = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const name = opts.name ?? this.suggestName(cwd);

    const args = [...defaultArgs, ...(opts.extraArgs ?? [])];
    const commandLine = this.buildCommandLine(cliPath, args);

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
    session.status = status;
    this._onDidChange.fire();
    // status is ephemeral, not persisted
  }

  rename(id: string, newName: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.name = newName;
    // VS Code doesn't expose terminal renaming via API directly, but the
    // tree label will update on next refresh.
    this.persist();
    this._onDidChange.fire();
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
      this.create({ name: r.name, cwd: r.cwd });
      created++;
    }
    return created;
  }

  private persist(): void {
    const records: PersistedSession[] = Array.from(this.sessions.values()).map((s) => ({
      name: s.name,
      cwd: s.cwd,
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
}
