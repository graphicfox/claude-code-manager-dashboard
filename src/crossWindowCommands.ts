import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import * as vscode from 'vscode';

export const COMMANDS_DIR = path.join(
  os.homedir(),
  '.claude',
  'claude-code-manager',
  'commands'
);

const POLL_FALLBACK_MS = 2_000;
const STALE_COMMAND_TTL_MS = 30_000;

interface FocusCommandFile {
  kind: 'focus';
  sessionId: string;
  requestedAt: string;
}

/**
 * Drops a one-shot command file in `~/.claude/claude-code-manager/commands/`
 * for another window to pick up. Currently the only command is "focus this
 * session of mine in your window".
 */
export class CrossWindowCommandSender {
  async requestFocus(targetWindowId: string, sessionId: string): Promise<void> {
    const random = Math.random().toString(36).slice(2, 10);
    const file = path.join(COMMANDS_DIR, `${targetWindowId}-${random}.json`);
    const tmp = `${file}.tmp`;
    const payload: FocusCommandFile = {
      kind: 'focus',
      sessionId,
      requestedAt: new Date().toISOString(),
    };
    try {
      await fsp.mkdir(COMMANDS_DIR, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(payload));
      await fsp.rename(tmp, file);
    } catch {
      // No way to surface this — silently no-op.
    }
  }
}

/**
 * Watches the commands directory for files matching `<ownPid>-*.json`,
 * consumes (reads + deletes) each one, and dispatches to the supplied
 * callback. Sweeps stale command files (> 30s old) on startup.
 */
export class CrossWindowCommandReceiver implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly ownWindowId: string,
    private readonly onFocus: (sessionId: string) => void
  ) {
    this.start();
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* noop */ }
      this.watcher = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
  }

  private start(): void {
    void this.sweepStale();
    void this.scan();
    try {
      fs.mkdirSync(COMMANDS_DIR, { recursive: true });
      this.watcher = fs.watch(COMMANDS_DIR, () => this.scheduleScan());
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
    this.pollTimer = setInterval(() => void this.scan(), POLL_FALLBACK_MS);
  }

  private scheduleScan(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.scan();
    }, 50);
  }

  private async scan(): Promise<void> {
    if (this.disposed) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(COMMANDS_DIR);
    } catch {
      return;
    }
    const prefix = `${this.ownWindowId}-`;
    for (const file of entries) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      const full = path.join(COMMANDS_DIR, file);
      let payload: FocusCommandFile | undefined;
      try {
        const raw = await fsp.readFile(full, 'utf8');
        payload = JSON.parse(raw) as FocusCommandFile;
      } catch {
        // Likely a partial write or stale junk; remove and move on.
        await fsp.unlink(full).catch(() => undefined);
        continue;
      }
      // Consume the file before dispatching so we don't loop on errors.
      await fsp.unlink(full).catch(() => undefined);
      if (!payload || payload.kind !== 'focus' || typeof payload.sessionId !== 'string') {
        continue;
      }
      try {
        this.onFocus(payload.sessionId);
      } catch {
        // Don't let a callback exception block subsequent commands.
      }
    }
  }

  private async sweepStale(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(COMMANDS_DIR);
    } catch {
      return;
    }
    const now = Date.now();
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(COMMANDS_DIR, file);
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > STALE_COMMAND_TTL_MS) {
          await fsp.unlink(full).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Bring the VS Code window that has `workspaceFolder` open to the foreground.
 *
 * Path-based approaches (`code <folder>`, `open -a <app> <folder>`) all go
 * through VS Code's main process which performs case-canonicalization on the
 * input path; if the user's stored workspace URI was opened with a different
 * case (e.g. `/Users/kim/work/...` vs the canonical `/Users/kim/Work/...`)
 * the canonical input misses the stored URI and VS Code opens a *new*
 * window. So on macOS we identify the window by **title** instead, via
 * AppleScript + System Events / AXRaise — which is path-resolution-proof.
 *
 * Note: the AXRaise call needs Accessibility permission for the calling
 * process. macOS prompts on first attempt; once granted, subsequent
 * attempts work silently.
 *
 * Linux / Windows: fall back to the bundled `code` CLI which doesn't have
 * the same case-collision issue.
 *
 * Failures are silent.
 */
export function revealVSCodeWindow(
  workspaceFolder?: string,
  workspaceName?: string
): void {
  try {
    const wf = workspaceFolder?.trim();
    const wn = workspaceName?.trim();

    if (process.platform === 'darwin') {
      revealMacOS(wf, wn);
      return;
    }

    if (wf) {
      const codeBin = bundledCodeBin();
      if (codeBin) {
        execFile(codeBin, [wf], () => undefined);
      } else {
        exec(`code ${quote(wf)}`, () => undefined);
      }
      return;
    }

    if (process.platform === 'linux') {
      exec(`wmctrl -a ${quote(vscode.env.appName || 'Visual Studio Code')}`, () => undefined);
    } else if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(${jsonString(vscode.env.appName || 'Visual Studio Code')})"`,
        () => undefined
      );
    }
  } catch {
    // Ignore.
  }
}

let accessibilityPromptShown = false;

function revealMacOS(
  workspaceFolder: string | undefined,
  workspaceName: string | undefined
): void {
  const appName = vscode.env.appName || 'Visual Studio Code';
  // System Events identifies the running app by its executable name. For
  // stable VS Code that's "Code"; for Insiders, "Code - Insiders"; for forks
  // we strip the "Visual Studio " prefix from appName.
  const processName = appName.replace(/^Visual Studio /, '');

  // Prefer workspaceName over folder basename: VS Code's default
  // `window.title` includes `${rootName}` which is `vscode.workspace.name`,
  // i.e. the workspace file's name for `.code-workspace` files (e.g.
  // "Siteflow-Next") and the folder basename for plain folder windows. The
  // basename of the workspaceFolder is sometimes too generic to disambiguate
  // (e.g. "app", "src") and won't appear in the title for multi-root
  // workspaces at all.
  const matchTerm = workspaceName || (workspaceFolder ? path.basename(workspaceFolder) : undefined);

  if (!matchTerm) {
    execFile(
      '/usr/bin/osascript',
      ['-e', `tell application ${appleQuote(appName)} to activate`],
      () => undefined
    );
    return;
  }

  // The script:
  // 1. Activates VS Code (brings the app forward; OS picks most-recent window).
  // 2. Uses System Events / AXRaise to bring the *specific* window forward,
  //    overriding the OS default. The System Events tell itself requires
  //    Accessibility permission for the calling process — if denied,
  //    osascript exits non-zero with -1743 / "not allowed assistive access".
  const script =
    `tell application ${appleQuote(appName)} to activate\n` +
    `delay 0.05\n` +
    `tell application "System Events"\n` +
    `  tell process ${appleQuote(processName)}\n` +
    `    set matches to (every window whose name contains ${appleQuote(matchTerm)})\n` +
    `    if (count of matches) > 0 then\n` +
    `      perform action "AXRaise" of (item 1 of matches)\n` +
    `    end if\n` +
    `  end tell\n` +
    `end tell`;

  execFile('/usr/bin/osascript', ['-e', script], (err, _stdout, stderr) => {
    if (!err) return;
    const text = `${stderr ?? ''} ${err.message ?? ''}`;
    if (
      !accessibilityPromptShown &&
      /(-1743|not allowed assistive access|not authoris(?:e|i)ng|user is not allowed)/i.test(text)
    ) {
      accessibilityPromptShown = true;
      void vscode.window
        .showWarningMessage(
          'Claude Code Manager needs Accessibility permission to switch between VS Code windows. Open System Settings → Privacy & Security → Accessibility and enable VS Code (or osascript), then try clicking again.',
          'Open Accessibility Settings'
        )
        .then((choice) => {
          if (choice === 'Open Accessibility Settings') {
            exec(
              'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
              () => undefined
            );
          }
        });
    }
  });
}

/** AppleScript-quote a string: wrap in double quotes and escape `"` and `\`. */
function appleQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function bundledCodeBin(): string | undefined {
  // vscode.env.appRoot is e.g. .../Visual Studio Code.app/Contents/Resources/app
  // — the bundled CLI is at <appRoot>/bin/code (or code.cmd on Windows).
  const root = vscode.env.appRoot;
  if (!root) return undefined;
  const exe = process.platform === 'win32' ? 'code.cmd' : 'code';
  const p = path.join(root, 'bin', exe);
  try {
    if (fs.existsSync(p)) return p;
  } catch {
    // ignore
  }
  return undefined;
}

function quote(s: string): string {
  if (process.platform === 'win32') return `"${s.replace(/"/g, '\\"')}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}
