---
description: "Sidebar redesign with status pills, workspace persistence, status bar item, and random session names"
alwaysApply: true
---

# Design Log #01: Sidebar Status, Persistence, and Random Names

## Background

The initial design (see [#00](#00-Initial_Design.md)) shipped a sidebar `TreeView` showing only `running` / `exited` status via icon swap, with no persistence — sessions died on workspace reload — and no overview surface outside the dashboard. Names were derived from the cwd's leaf directory.

## Problem

- Two-state status (`running` / `exited`) doesn't reflect what a Claude session is actually doing. Users running multiple parallel agents need to glance at the sidebar and immediately see which sessions are waiting for input vs. busy vs. blocked on a permission prompt.
- The sidebar is the primary surface for managing sessions, but `TreeView` items are styled by VS Code and cannot have colored backgrounds, larger fonts, or custom padding.
- Workspace reloads silently nuked all sessions — user had to remember every cwd and respawn manually.
- No always-visible indicator of how many sessions are running.
- Folder-leaf names (`app`, `app-2`, `app-3`) collide constantly when running parallel agents in the same project.

## Questions and Answers

- **Q**: Can we keep the `TreeView` and use `FileDecorationProvider` for richer status?
  - **A**: No. Decorations give us a colored badge and tinted text, but no background fill, no padding control, and no font-size override. The user requirements (background highlight, larger text, more padding) require full HTML, which means `WebviewView`.
- **Q**: Should status be persisted across reloads?
  - **A**: No. Status is ephemeral runtime state that depends on what the (now-dead) Claude process was doing. Restored sessions start fresh, so they default to `idle`.
- **Q**: How do we avoid wiping persistence during the close-cascade in `dispose()`?
  - **A**: Set a `disposing` flag on `SessionManager` before tearing down. The `onDidCloseTerminal` handler skips state mutation (and therefore `persist()`) when the flag is set. Persistence already reflects the live set from prior `persist()` calls, so it's correct on next launch.
- **Q**: Should restoration be automatic?
  - **A**: Tri-state config `claudeCodeManager.restoreOnActivate` = `ask` | `always` | `never`, default `ask`. Spawning multiple terminals without consent is too noisy.

## Design

1. **Sidebar is now a `WebviewViewProvider`**: [src/sessionWebviewProvider.ts](../src/sessionWebviewProvider.ts) replaces the old `SessionTreeProvider`. Same view id (`claudeCodeSessions`), so the activity bar slot is unchanged. Renders as cards with status-tinted backgrounds, 14px name, 11px mono cwd, status pill with inline-SVG icon, status-row buttons to mutate state, and an action row (Focus / Send… / Rename / Kill).
2. **Six-state status enum**: `idle | busy | question | permission | done | exited`. The first five are user-meaningful runtime states; `exited` covers terminated sessions. Set manually today via the sidebar pills or `claudeCodeManager.setStatus`. The model is shaped so a future watcher (see [#02](#02-Status_Auto_Detection.md) when it lands) can call `manager.setStatus(id, status)` directly.
3. **Persistence in `workspaceState`**: key `claudeCodeManager.sessions.v1`, payload `Array<{name, cwd}>`. Written on every mutation (`create`, `rename`, `kill`, `killAll`, external close). Status is deliberately not persisted — see Q&A.
4. **Restore-on-activate**: `maybeRestore()` runs after `activate()`. Skips if there are already live sessions or persistence is empty. Honors the `restoreOnActivate` config. Manual entry points: `claudeCodeManager.restoreSessions` and `claudeCodeManager.clearSavedSessions`.
5. **Status bar item**: right-aligned, `$(sparkle) Claude: N`, click → openDashboard. Tooltip is a markdown list of session names + relative cwds. Toggleable via `claudeCodeManager.statusBar.enabled`.
6. **Random names**: 25 adjectives × 25 animals = 625 combos like `fuzzy-dragon`. Replaces folder-leaf naming. Dedupes against live sessions; fallback appends a base-36 timestamp suffix.
7. **Activation event**: switched from empty `activationEvents` (lazy, view-triggered) to `["onStartupFinished"]` so the status bar and restore prompt appear on workspace open instead of waiting for the user to click into the view.

## Implementation Plan

1. ✅ `SessionManager`: replace `status` literal type with `SessionStatus` union, add `setStatus`, swap `suggestName` for the random generator, add `persist`/`getPersisted`/`clearPersisted`/`restorePersisted`, set `disposing` flag in `dispose()` to protect persistence during shutdown.
2. ✅ Create [src/sessionWebviewProvider.ts](../src/sessionWebviewProvider.ts) with the card UI; subscribe to `manager.onDidChange`; postMessage protocol covers `newSession`, `focus`, `kill`, `rename`, `setStatus`, `sendPrompt`, `openDashboard`. Input prompts (`rename`, `sendPrompt`) are handled inline in the message dispatcher rather than dispatching to extra commands.
3. ✅ Delete [src/sessionTree.ts](../src/sessionTree.ts).
4. ✅ [src/extension.ts](../src/extension.ts): register `WebviewViewProvider`, drop `SessionTreeItem` branch from `resolveSessionId` (now `arg?: string`), add status bar wiring + `maybeRestore`, register `setStatus` / `restoreSessions` / `clearSavedSessions` commands.
5. ✅ [package.json](../package.json): mark the view as `"type": "webview"`, drop `view/item/context` menus and `viewsWelcome` (webviews ignore both), add `restoreOnActivate` and `statusBar.enabled` config keys, add `onStartupFinished` activation, add the three new commands.
6. ✅ [src/dashboard.ts](../src/dashboard.ts): swap the green/gray dot for the same status pill styling so the dashboard and sidebar match.

## Examples

### Status pill in the sidebar

```ts
// sessionWebviewProvider.ts
const statusButtons = STATUSES.map(st => `
  <button class="s-${st} ${s.status === st ? 'active' : ''}"
          data-set-status="${st}" data-id="${s.id}">${LABELS[st]}</button>
`).join('');
```

```css
.session.s-busy       { background: rgba(56, 139, 253, 0.10); border-color: rgba(56, 139, 253, 0.45); }
.session.s-question   { background: rgba(255, 184, 0, 0.10); border-color: rgba(255, 184, 0, 0.50); }
.session.s-permission { background: rgba(255, 122, 0, 0.12); border-color: rgba(255, 122, 0, 0.55); }
.session.s-done       { background: rgba(63, 185, 80, 0.10); border-color: rgba(63, 185, 80, 0.45); }
```

### Persistence handshake

```ts
// sessionManager.ts
dispose(): void {
  // Persistence already reflects the live set from prior persist() calls;
  // we deliberately do NOT clear it here so sessions can be restored next launch.
  this.disposing = true;
  for (const session of this.sessions.values()) session.terminal.dispose();
  this.sessions.clear();
  this._onDidChange.dispose();
}
```
