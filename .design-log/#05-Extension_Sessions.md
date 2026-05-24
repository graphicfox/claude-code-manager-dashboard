---
description: "Design log for opening sessions via the official Claude Code VS Code extension instead of a CLI terminal"
alwaysApply: true
---

# Design Log #05: Extension Sessions

## Background
Until now, every session in `claude-code-manager` is a `vscode.Terminal` running the `claude` CLI (see [#00](./%2300-Initial_Design.md), [#01](./%2301-Sidebar_Status_And_Persistence.md)). Anthropic also ships an official VS Code extension — `anthropic.claude-code` — that provides a graphical chat panel in the editor area or sidebar. The two share the same JSONL conversation history under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, but the official extension owns the session lifecycle inside its own panel.

The official extension exposes a documented URI handler at `vscode://anthropic.claude-code/open` with optional `prompt` and `session` query parameters. Firing this URI opens a new tab in the focused VS Code window (or resumes an existing session if `session=` is supplied).

## Problem
Some users prefer the official extension's GUI over a terminal-based CLI but still want this manager's strengths — the cross-window visibility from [#04](./%2304-Cross_Window_Visibility.md), the status pills, the sidebar/dashboard, the status-bar counter. Today they have to choose: use this manager and live with terminals, or use the official extension and lose the manager's UI.

We want a third option: tell `claudeCodeManager` whether a "New Session" should spawn a CLI terminal (current behaviour) or open a tab in the official extension. The manager keeps tracking the session as a "shadow" entry in its UI either way.

## Questions and Answers
- **Q**: Why use the URI handler instead of `vscode.commands.executeCommand('anthropic.claude-code.openInNewTab')`?
  - **A**: The URI handler is the only documented programmatic entry point in the official extension's docs. Internal command IDs aren't part of the public surface and can change between releases. The URI handler is stable and forward-compatible.
- **Q**: Can extension shadows participate in the JSONL-based status auto-detection from [#02](./%2302-Status_Auto_Detection.md)?
  - **A**: Not in v1. The detector's "claim a new file" race in `StatusDetector.beginPolling()` works because we know the CLI session was just spawned in a specific cwd and the next new `<id>.jsonl` to appear is ours. For extension sessions we don't have that timing guarantee — the user might already have an extension tab in the same cwd, or open one externally. Skipping the detector for `kind === 'extension'` keeps things deterministic. Status remains user-set via the existing pills. Discovering the extension's session id is left as a follow-up (would let us re-fire the URI handler with `?session=` for focus, and enable the detector for these sessions).
- **Q**: Does `newSessionInFolder` respect the toggle?
  - **A**: No. The URI handler has no `cwd` query parameter — it opens in the focused window's folder. Honouring a custom folder requires a terminal, so `newSessionInFolder` is always `kind: 'cli'`. The plain `newSession` and `resumeSession` commands respect the toggle (the URI handler accepts `?session=<id>` for resume).
- **Q**: How does `kill` work for extension shadows?
  - **A**: It can't actually kill the official extension's tab — that's the user's responsibility. The "Kill" button becomes "Remove" for these cards: drop the manager-side metadata, leave the actual extension tab alone.
- **Q**: Should extension shadows be persisted across reloads?
  - **A**: They're persisted in the workspaceState payload (the `kind` field is part of `PersistedSession`) but on `restorePersisted()` we silently skip extension entries. Re-firing the URI handler at activation would open a flurry of tabs the user didn't ask for, and we have no way to attach to the *existing* prior tab. CLI sessions restore as before.

## Design
1. **`SessionKind` discriminator**: introduce `export type SessionKind = 'cli' | 'extension'`. Add `kind: SessionKind` to `ClaudeSession` and `PersistedSession`. Make `terminal: vscode.Terminal | undefined` since extension shadows have no terminal.
2. **Config**: new `claudeCodeManager.sessionType: "terminal" | "extension"` (default `"terminal"`). The `claudeCodeManager.newSession` command reads this default.
3. **`SessionManager.create({ kind? })`**: accept an optional `kind`; default from config. Branch internally — `cli` keeps the existing `vscode.window.createTerminal()` path; `extension` builds and fires a `vscode://anthropic.claude-code/open` URI via `vscode.env.openExternal()` and adds a shadow entry with `terminal: undefined`.
4. **`kill`/`focus`/`sendPrompt` branch on kind**: extension shadows have no terminal. `kill` becomes "remove from list" with a softer confirm copy. `focus` and `sendPrompt` show a one-line info message explaining that this session is owned by the official extension.
5. **`StatusDetector` filter**: only attach to `kind === 'cli'` sessions.
6. **UI changes**: sidebar and dashboard render an `[Extension]` badge next to the session name when `kind === 'extension'`. The action row hides Focus/Send… and labels Kill as "Remove" for extension shadows. Status pills remain interactive.
7. **`newSessionChooseType` command**: a new command that shows a 2-item quick-pick (Terminal / Extension) regardless of the configured default. Surfaced in the command palette and in the sidebar view-title menu (`navigation@1.5`, between New and Resume).
8. **`resumeSession`**: respects the configured `sessionType`. When `extension`, passes `kind: 'extension'` plus `resumeSessionId` to `create()`, which appends `?session=<id>` to the URI.
9. **Persistence**: include `kind` in `PersistedSession`. On `restorePersisted()`, skip records where `kind === 'extension'`.
10. **Cross-window manifest**: `ManifestSession` payload from [#04](./%2304-Cross_Window_Visibility.md) gains `kind`, so other windows can render the badge correctly.

## Implementation Plan
1. Add `claudeCodeManager.sessionType` to `package.json` `contributes.configuration.properties`.
2. Add `claudeCodeManager.newSessionChooseType` to `package.json` `contributes.commands` and `contributes.menus.view/title`.
3. In `src/sessionManager.ts`: add `SessionKind`, extend `ClaudeSession` and `PersistedSession` with `kind`, make `terminal` optional, branch `create()` into `createCli()` and `createExtensionShadow()`, gate `kill`/`focus`/`sendPrompt`/`onDidCloseTerminal`/`killAll`/`dispose` on `kind === 'cli'`, and skip extension entries in `restorePersisted()`.
4. In `src/extension.ts`: add `newSessionChooseType` command, route `resumeSession` through `sessionType`, gate `receiver` callback on `terminal` existing, pass `kind` from sidebar messages where relevant.
5. In `src/sessionWebviewProvider.ts` and `src/dashboard.ts`: add `kind` to the per-session view model, render the `[Extension]` badge, hide Focus/Send… for extension shadows, swap "Kill" → "Remove" copy.
6. In `src/statusDetector.ts`: filter `manager.list()` by `kind === 'cli'` in `sync()`.
7. In `src/manifestPublisher.ts`: include `kind` in `ManifestSession`.

## Examples

### URI handler invocation
```ts
// New session: open a fresh tab in the focused VS Code window.
await vscode.env.openExternal(
  vscode.Uri.parse('vscode://anthropic.claude-code/open')
);

// Resume by JSONL session id (the URI handler accepts ?session=<id>).
await vscode.env.openExternal(
  vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`)
);
```

### Branched `create()`
```ts
// In SessionManager.create()
const kind: SessionKind = opts.kind
  ?? config.get<SessionKind>('sessionType', 'terminal') === 'extension'
    ? 'extension'
    : 'cli';

if (kind === 'extension') return this.createExtensionShadow(opts);
return this.createCli(opts);
```

### Persisted shape
```ts
// PersistedSession
{
  name: 'velvet-otter',
  cwd: '/Users/kim/Work/some-project',
  kind: 'extension',
  manuallyRenamed: true,
  extensionSessionId: '019358a4-...'  // captured by detector after first JSONL appears
}
// On restore, createExtensionShadow is called with `resumeSessionId =
// extensionSessionId`. The URI handler resumes the prior conversation if
// the JSONL is still on disk, else the extension opens a fresh tab.
```

## Addendum: Session ID Discovery & Restore

Initial v1 explicitly skipped both auto-status and restore for extension shadows on the assumption that the JSONL-based detector couldn't safely claim a file. In practice the existing `beginPolling` heuristic — snapshot the cwd dir at attach time, claim the first new file — works equally well for the official extension, since the extension and CLI write to the same `~/.claude/projects/<encoded-cwd>/<id>.jsonl` path. So:

- The detector runs for both kinds. The basename of the claimed JSONL (minus `.jsonl`) is the extension's session id; `setExtensionSessionId()` stores it on the live session and persists.
- Persisted records keep `extensionSessionId` alongside `kind`. On `restorePersisted()`, extension shadows are recreated by re-firing `vscode://anthropic.claude-code/open?session=<id>` — per the official docs, that focuses an already-open tab or re-opens the prior conversation.
- `focus()` for extension shadows fires the same URI when an id is known. Without an id (the user hasn't sent the first message yet, so no JSONL exists) Focus stays disabled with a tooltip explaining how to claim it.
- New setting `claudeCodeManager.autoStatus.permissionThresholdMs` (default 4000ms, was hardcoded 10000ms) tunes how long a `busy` tool_use sits before escalating to `permission`. The original 10s was conservative — most auto-allowed tools complete much faster, so the lower default makes pending permission requests feel responsive while still tolerating short tool runs.

## Addendum: Auto-Discovery

Sessions started outside of this manager — directly in the official extension's UI, or by running `claude` in a non-managed terminal — are now picked up automatically by [`AutoDiscovery`](../src/autoDiscovery.ts). It polls `~/.claude/projects/<encoded-cwd>/` for the current workspace's first folder on a configurable interval (default 10s) and adopts any JSONL file that:
1. isn't already tracked by an existing session (by `extensionSessionId` or `jsonlPath`),
2. wasn't explicitly removed by the user in this VS Code window,
3. has been written within the freshness window (default 60s).

Adopted sessions are inserted via `SessionManager.importExtensionSession()` as `kind: 'extension'` with `jsonlPath` and `extensionSessionId` pre-set so the existing detector tails them immediately, picks up `ai-title` for auto-rename, and accumulates usage from history.

User-removed sessions are detected implicitly: if a session id was live on the previous tick and is no longer live (and we didn't re-discover it because the user's removal didn't recreate it), we add it to an in-memory `ignored` set. The set is per-window-instance — restarting VS Code clears it, which means a still-active discarded session may re-appear on next launch. Acceptable for v1.

CLI sessions just spawned by us may briefly have no `jsonlPath` while the detector is claiming. To avoid double-adoption, AutoDiscovery skips entirely if any `kind: 'cli'` session in the current cwd is still un-claimed.

New settings:
- `claudeCodeManager.autoDiscovery.enabled` (default `true`)
- `claudeCodeManager.autoDiscovery.intervalMs` (default `10000`, range `2000`–`300000`)
- `claudeCodeManager.autoDiscovery.freshnessMs` (default `60000`, range `5000`–`3600000`)

## Addendum: Closed-Session Detection

Closing a Claude Code extension tab doesn't fire any event we own — VS Code's tab API gives us a generic `onDidChangeTabs` close, but the closed `Tab` carries no session id. Two complementary signals close the loop:

1. **JSONL inactivity timer** — `SessionManager` now tracks `lastActivityAt` per session, bumped from `StatusDetector.readNew()` whenever the JSONL grows. The new `LifecycleMonitor` ticks every 30s; if a session's `lastActivityAt` is older than `autoExit.idleMs` (default 10 min), it's flipped to `exited`. This catches both closed extension tabs and dormant CLI sessions where the user typed `exit` at the prompt without closing the terminal.
2. **Tab close listener** — `LifecycleMonitor` subscribes to `vscode.window.tabGroups.onDidChangeTabs`. When a tab whose `input.viewType` includes `claude` or `anthropic` closes, we look for an extension shadow whose name appears in (or contains) the closed tab's label and mark it exited immediately. Best-effort name-match heuristic; if it misfires, the idle timer covers it within 10 min.

Exited sessions stay visible (with the existing dimmed `exited` styling) until the user clicks "Clear N closed" in the sidebar or dashboard, or runs the new `claudeCodeManager.clearClosedSessions` command. Persistence reflects the live set — once cleared, they don't re-appear on reload.

Why not auto-remove? Showing "Exited" gives the user a beat to confirm or recover (typing in a Claude tab that's still open re-bumps the activity timer and flips status back to idle). Auto-removal would race with that recovery for sessions that briefly look idle but resume.
