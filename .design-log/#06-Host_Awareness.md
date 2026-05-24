---
description: "Design log for making the extension host-aware so it works correctly inside VS Code forks (Antigravity IDE, Cursor, Insiders, …) — not just stock VS Code"
alwaysApply: true
---

# Design Log #06: Host Awareness

## Background
VS Code's Extension API is implemented by a family of editors that share the same `vscode` module surface but differ in identity. Stock VS Code registers the `vscode://` URI scheme and ships its launcher at `<appRoot>/bin/code`. Insiders uses `vscode-insiders://` and `bin/code-insiders`. Google's Antigravity IDE (bundle id `com.google.antigravity-ide`) uses `antigravity-ide://` and `bin/antigravity-ide`. Cursor uses `cursor://` and `bin/cursor`.

`vscode.env` exposes the host identity at runtime — `appName`, `appRoot`, and `uriScheme`. We were already reading `appName` for the macOS reveal path (see [#04](./%2304-Cross_Window_Visibility.md)) but two other places had hardcoded VS Code-isms.

## Problem
Two functional bugs surfaced once a user installed the extension into Antigravity IDE:

1. **Extension-shadow sessions launch the wrong app.** [#05](./%2305-Extension_Sessions.md) added "extension shadow" sessions backed by the official `anthropic.claude-code` extension's URI handler. The handler was invoked with a literal `vscode://anthropic.claude-code/open?...` URI; the OS routes `vscode://` to whichever editor owns that scheme (stock VS Code on most machines), so clicking "New Session" or "Focus" from inside Antigravity woke up VS Code and opened the tab there — not in Antigravity.
2. **Cross-window window-focus on Linux / Windows misses the launcher.** `revealVSCodeWindow()` (Linux + Windows path) called `bundledCodeBin()`, which looked specifically for `<appRoot>/bin/code` or `bin/code.cmd`. On Antigravity that file doesn't exist; the fallback `exec("code …")` then resolved to VS Code's `code` on PATH (if installed at all), reopening the workspace in the wrong editor.

Additionally several user-facing strings (tooltips, the accessibility-permission toast, package.json descriptions) hardcoded "VS Code", which looks wrong on every fork.

## Questions and Answers
- **Q**: Is `vscode.env.uriScheme` reliable across forks?
  - **A**: Yes — it's a stable VS Code API surface (since 1.30). Antigravity returns `'antigravity-ide'`, Cursor returns `'cursor'`, Insiders returns `'vscode-insiders'`. The official Anthropic extension registers its URI handler with `vscode.window.registerUriHandler()` and each host wires its own scheme to the handler dispatcher, so `${hostUriScheme()}://anthropic.claude-code/open` works on every host that has the extension installed.
- **Q**: Why not just check `appName` and pick a scheme from a table?
  - **A**: `uriScheme` is the source of truth and doesn't drift if a fork rebrands. A lookup table would need updating for every new fork; `vscode.env.uriScheme` already encodes the right answer.
- **Q**: What if `<appRoot>/bin/` has multiple launcher candidates (e.g. `code` and `code-tunnel`)?
  - **A**: We prefer the one matching the bundle slug derived from `appRoot` ("Antigravity IDE.app" → `antigravity-ide`), falling back to the first plain-file candidate. Good enough for the editors we care about; if a new fork ships an oddly-named launcher we'll add a special case then.
- **Q**: Should the URI scheme also be applied to the cross-window manifest (design log [#04](./%2304-Cross_Window_Visibility.md))?
  - **A**: No. The manifest is filesystem JSON shared between windows; it doesn't fire URIs. The `revealVSCodeWindow()` path is where any URI-or-CLI work happens.
- **Q**: Do we rename `revealVSCodeWindow()` to be host-neutral?
  - **A**: Not in this change — too many call sites for a renaming-only diff. The behaviour inside the function is now host-aware regardless of name; we can rename in a follow-up.

## Design
1. **New module [src/host.ts](../src/host.ts)** centralises three reads:
   - `hostUriScheme()` → `vscode.env.uriScheme`. Used to build URIs that route back to the same host.
   - `hostAppName()` → `vscode.env.appName` with a `'Visual Studio Code'` fallback if undefined.
   - `bundledHostCli()` → scans `<appRoot>/bin/` for the launcher, prefers a name matching the bundle slug derived from `appRoot`. Returns `undefined` if `appRoot` is missing or `bin/` is empty.
2. **`SessionManager` URIs** now use `${hostUriScheme()}://anthropic.claude-code/open[?session=…]` in both `createExtensionShadow()` and `focus()`.
3. **`revealVSCodeWindow()` on Linux/Windows** uses `bundledHostCli()`. When it can't find the launcher there's no `code`-on-PATH fallback any more — silent failure is preferable to reopening the workspace in the wrong editor.
4. **Accessibility toast** in `revealMacOS()` now inlines `hostAppName()` so the message reads "needs Accessibility permission to switch between Antigravity IDE windows" (or "VS Code windows", as appropriate).
5. **UI strings**: sidebar / dashboard tooltips and `package.json` config descriptions drop the "VS Code" branding and use "editor" / "editor extension" instead.

## Implementation Plan
1. Add `src/host.ts` exporting `hostUriScheme`, `hostAppName`, `bundledHostCli`.
2. In `src/sessionManager.ts`: import `hostUriScheme`, replace the two literal URI strings, refresh the surrounding doc comments.
3. In `src/crossWindowCommands.ts`: delete `bundledCodeBin()`, swap call sites for `bundledHostCli()`, drop the `code`-on-PATH fallback, swap `appName || 'Visual Studio Code'` for `hostAppName()`, and refresh the warning toast copy.
4. In `src/sessionWebviewProvider.ts` and `src/dashboard.ts`: change "VS Code extension"/"VS Code window" tooltip strings to "editor extension"/"editor window".
5. In `package.json`: update `description`, `claudeCodeManager.sessionType` enum description, and `claudeCodeManager.shell` description.

## Examples

### Host-aware URI build
```ts
import { hostUriScheme } from './host';

const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
const uri = vscode.Uri.parse(
  `${hostUriScheme()}://anthropic.claude-code/open${params}`
);
void vscode.env.openExternal(uri);
// VS Code stable → vscode://...
// Antigravity   → antigravity-ide://...
// Cursor        → cursor://...
```

### Locating the bundled launcher
```ts
import { bundledHostCli } from './host';

const cli = bundledHostCli();
if (cli) {
  execFile(cli, [workspaceFolder], () => undefined);
}
// In Antigravity: /Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide
// In VS Code:     /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code
```
