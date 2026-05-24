import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Returns the URI scheme the host editor registers with the OS. For VS Code
 * stable this is `'vscode'`, for Insiders `'vscode-insiders'`, for the
 * Antigravity IDE fork `'antigravity-ide'`, for Cursor `'cursor'`, etc.
 *
 * Use this when building deep links into other extensions installed in the
 * same host — `vscode://<ext>/<path>` only routes back to VS Code itself,
 * so hardcoding `vscode://` breaks the moment we're running inside a fork.
 */
export function hostUriScheme(): string {
  return vscode.env.uriScheme;
}

/**
 * Returns the display name of the host editor (e.g. `'Visual Studio Code'`,
 * `'Antigravity IDE'`). The fallback only kicks in if `vscode.env.appName`
 * is somehow undefined, which shouldn't happen on any real host.
 */
export function hostAppName(): string {
  return vscode.env.appName || 'Visual Studio Code';
}

/**
 * Locates the bundled launcher CLI inside the host's `app/bin/` folder —
 * VS Code ships `bin/code`, Insiders `bin/code-insiders`, Antigravity
 * `bin/antigravity-ide`, etc. Returns the absolute path if found, or
 * `undefined` if we can't make sense of the host layout.
 *
 * Strategy: read `<appRoot>/bin/`, ignore the `remote-cli` / `helpers`
 * subdirectories, and pick the launcher whose name best matches the host.
 * On Windows the launcher carries a `.cmd` / `.bat` extension.
 */
export function bundledHostCli(): string | undefined {
  const root = vscode.env.appRoot;
  if (!root) return undefined;
  const binDir = path.join(root, 'bin');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const isWin = process.platform === 'win32';
  const candidates = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => {
      if (isWin) return /\.(cmd|bat|exe)$/i.test(name);
      return !name.includes('.'); // unix launchers are extension-less
    })
    .filter((name) => name !== 'remote-cli' && name !== 'helpers');

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return path.join(binDir, candidates[0]);

  // Multiple launchers: prefer the one that best matches the host bundle
  // name (e.g. `Antigravity IDE.app` → `antigravity-ide`).
  const preferred = hostBundleSlug();
  if (preferred) {
    const match = candidates.find((name) => {
      const stem = name.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase();
      return stem === preferred;
    });
    if (match) return path.join(binDir, match);
  }

  return path.join(binDir, candidates[0]);
}

/**
 * Derives a slugified host name from `appRoot` — e.g.
 * `/Applications/Antigravity IDE.app/Contents/Resources/app` →
 * `'antigravity-ide'`. Falls back to slugifying `appName`. Returns
 * `undefined` if neither yields anything usable.
 */
function hostBundleSlug(): string | undefined {
  const root = vscode.env.appRoot;
  if (root) {
    const match = root.match(/([^/\\]+)\.app[\\/]/i);
    if (match) {
      return match[1].toLowerCase().replace(/\s+/g, '-');
    }
  }
  const name = vscode.env.appName;
  if (name) return name.toLowerCase().replace(/\s+/g, '-');
  return undefined;
}
