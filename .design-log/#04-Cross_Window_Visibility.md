---
description: "Cross-window visibility — see Claude sessions running in other VS Code windows on the same machine via per-window manifest files"
alwaysApply: true
---

# Design Log #04: Cross-Window Visibility

## Background

Through [#01](#01-Sidebar_Status_And_Persistence.md) and [#02](#02-Status_Auto_Detection.md) the sidebar grew rich, auto-tracking, idiomatic status pills. [#03](#03-Notifications_Usage_Resume.md) added notifications, badges, and usage / cost. Up to this point everything has been per-window: each VS Code window's `SessionManager` only knows about sessions spawned in *that* window.

Real users open multiple VS Code windows. While you're working in window B, you have no way to see that the Claude session in window A has been waiting on a permission prompt for the last four minutes. You can't even tell from the OS that anything is going on — VS Code's status bar in window B reflects only window B.

This entry adds an opt-out toggle that merges sessions from sibling VS Code windows into the sidebar and dashboard as read-only cards.

## Problem

- **No cross-window awareness**. Sessions in other windows are invisible from here.
- **Invisible attention states**. A `question` or `permission` session in window A doesn't surface anywhere that window B's user might notice.
- **Double-spawn risk**. Without seeing other windows' sessions, you might kick off a duplicate session for the same project.
- **No global cost view**. Total spend across all open windows is impossible to see at a glance.

## Questions and Answers

- **Q**: How do windows discover each other's sessions? JSONL-only scanning under `~/.claude/projects/`, or a per-window manifest file the windows write themselves?
  - **A**: Per-window manifest. JSONL alone can't reuse user-assigned names ([sessionManager.ts:226-235](../src/sessionManager.ts) `rename()` only updates in-memory + workspaceState), can't reliably distinguish "running" from "JSONL last touched 4s ago because Claude is thinking", and gives no clean signal when a window crashes. The manifest carries the names, statuses, and usage each owning window has already computed — strictly better than rederiving from raw JSONL.
- **Q**: What's the manifest path?
  - **A**: `~/.claude/claude-code-manager/windows/<pid>.json`. Sibling to `~/.claude/projects/` so it co-locates with Claude Code's own state. One file per running extension host.
- **Q**: Window id — pid or a UUID stashed in `workspaceState`?
  - **A**: `String(process.pid)`. Free, unique per running extension host. A crash naturally produces a new id on next launch — no "is this the same window restarting?" disambiguation needed. Pid recycling is a theoretical concern but extension hosts live long enough that within the 30s freshness window it's effectively impossible.
- **Q**: How do we avoid readers seeing partial JSON during a write?
  - **A**: Atomic writes — serialize to `<pid>.json.tmp`, then `fsp.rename` to `<pid>.json`. Readers also wrap `JSON.parse` in try/catch as belt-and-braces.
- **Q**: How fresh must a manifest be to count?
  - **A**: 30s. Live windows heartbeat every 5s, so 30s gives 6× headroom. Stale-sweep deletes files older than 120s (4× freshness TTL) to allow brief FS hiccups without churn.
- **Q**: Toasts for attention states — fire in all windows or only the owner?
  - **A**: Owner only. You can't focus a foreign session, so a toast with a Focus button that no-ops is worse than silence. External cards still show the orange status pill, so the visual signal is preserved when you glance at the sidebar.
- **Q**: Status bar counter — local-only or combined?
  - **A**: Combined (local + external). The user's stated goal was "see what is going on" — a global count answers that question directly. Activity-bar badge follows the same rule.
- **Q**: What can you do with an external session card?
  - **A**: Read-only display + click-to-reveal. Clicking sends a focus request to the owning window via a second IPC channel (`commands/<targetPid>-<reqId>.json`). The owner consumes the file, calls `terminal.show(false)` on the target session, and runs a platform-specific app-activation (`osascript` on macOS, `wmctrl` on Linux, `WScript.Shell` on Windows) to bring VS Code forward. No cross-window kill / send / rename — those would need a request/response protocol; out of scope for #04.
- **Q**: How do we keep heartbeat-only writes from spamming the webviews?
  - **A**: The tracker compares a stable serialized snapshot of the visible-set before firing `onDidChange`. Heartbeats that don't change anything besides `lastUpdated` are filtered out.
- **Q**: What happens when the toggle is off?
  - **A**: The viewer (`ExternalSessionTracker`) stops watching and returns `[]`. The publisher keeps writing — turning visibility off in *this* window doesn't hide *this window's* sessions from other windows. "Show me other windows" is a viewer setting, not a publisher setting.

## Design

1. **Per-window manifest as IPC**. `~/.claude/claude-code-manager/windows/<pid>.json`, written atomically on every `onDidChange` / `onDidChangeStatus` plus a 5s heartbeat. Carries `windowId`, `lastUpdated`, and the session list.
2. **`ManifestPublisher`**. Subscribes to the local `SessionManager`, writes the manifest, runs the heartbeat, removes its own file on `dispose()`. A `disposed` flag (mirroring [sessionManager.ts:96](../src/sessionManager.ts) `disposing` pattern) keeps the heartbeat from racing during shutdown.
3. **`ExternalSessionTracker`**. Watches the manifests dir with `fs.watch` + 5s polling fallback (mirror the pattern in [statusDetector.ts:160-173](../src/statusDetector.ts)). Debounces re-reads by 100ms, drops own file by `windowId`, drops files where `Date.now() - lastUpdated > 30_000`, swallows JSON-parse failures. Exposes `list(): ExternalSession[]` and `onDidChange`. Sweeps stale manifests (>120s old) on startup and once per minute.
4. **`CrossWindowCommandSender` and `CrossWindowCommandReceiver`**. Second tiny IPC channel for focus requests. Sender writes `~/.claude/claude-code-manager/commands/<targetPid>-<random>.json`. Receiver in each window watches its own pid prefix, consumes + deletes incoming files, and dispatches via a callback: `terminal.show(false)` on the matching session + a best-effort platform window-activation.
5. **`activateVSCodeWindow()` helper**. macOS: `osascript -e 'tell application id "com.microsoft.VSCode" to activate'`. Linux: `wmctrl -a "Visual Studio Code"` if present. Windows: PowerShell `WScript.Shell.AppActivate`. Wrapped in try/catch, silent on failure. Because the receiver just `terminal.show()`'d, that window is VS Code's most-recent — `activate` brings it forward in practice.
6. **`claudeCodeManager.showAllWindows` setting**. Boolean, default `true`. Tracker honours it; publisher does not (see Q&A above).
7. **Webview merge with section header**. `SessionWebviewProvider` builds local + external arrays; renders local first, then a `<h3 class="section">Other windows</h3>` separator, then externals. External cards have dashed muted borders, no `status-row` / `actions` / `prompt-row`, and a card-level click that posts `revealExternal`. Dashboard mirrors this — externals get a single row in their own grid section, with Focus rebound to `revealExternal`.
8. **Combined status bar + activity badge**. `updateStatusBar()` and the badge counter sum local + external. Tooltip groups them into "This window" and "Other windows" sections so you can see what each side contributes. Toasts (the existing notifier) remain local-only — no change.

## Implementation Plan

1. ✅ Add `claudeCodeManager.showAllWindows` to [package.json](../package.json) configuration block.
2. ✅ Create [src/manifestPublisher.ts](../src/manifestPublisher.ts) — `ManifestPublisher` class, `WindowManifest` + `ManifestSession` types, atomic write, 5s heartbeat, `disposed` flag.
3. ✅ Create [src/externalSessionTracker.ts](../src/externalSessionTracker.ts) — `ExternalSessionTracker` class, `ExternalSession` type, watch-or-poll, freshness filter, snapshot-diff to suppress no-op events, stale sweep, `showAllWindows` config gate.
4. ✅ Create [src/crossWindowCommands.ts](../src/crossWindowCommands.ts) — `CrossWindowCommandSender`, `CrossWindowCommandReceiver`, `activateVSCodeWindow()`.
5. ✅ Wire all three into [src/extension.ts](../src/extension.ts) `activate()`. Update `updateStatusBar()` to combine local + external counts and group the tooltip.
6. ✅ [src/sessionWebviewProvider.ts](../src/sessionWebviewProvider.ts): extend `SessionVM` with `external` + `windowId`, merge in `update()`, render section header + dashed external card + `revealExternal` handler.
7. ✅ [src/dashboard.ts](../src/dashboard.ts): same shape of merge + render changes, totals row split into "This window" / "Other windows" when externals exist.

## Examples

### Manifest schema

```ts
// manifestPublisher.ts
export interface WindowManifest {
  version: 1;
  windowId: string;        // String(process.pid)
  lastUpdated: string;     // ISO timestamp
  sessions: ManifestSession[];
}

export interface ManifestSession {
  id: string;
  name: string;
  cwd: string;
  status: SessionStatus;
  startedAt: string;       // ISO
  jsonlPath?: string;
  manuallyRenamed: boolean;
  usage: SessionUsage;
}
```

### Atomic write

```ts
// manifestPublisher.ts
private async writeManifest(): Promise<void> {
  if (this.disposed) return;
  const manifest: WindowManifest = {
    version: 1,
    windowId: this.id,
    lastUpdated: new Date().toISOString(),
    sessions: this.manager.list().map(toManifestSession),
  };
  try {
    await fsp.mkdir(WINDOWS_DIR, { recursive: true });
    await fsp.writeFile(this.tmpPath, JSON.stringify(manifest));
    await fsp.rename(this.tmpPath, this.filePath);
  } catch {
    // Disk full / permissions — silently disable this window's publishing.
  }
}
```

### Tracker freshness filter

```ts
// externalSessionTracker.ts
private async readAll(): Promise<ExternalSession[]> {
  let entries: string[];
  try { entries = await fsp.readdir(WINDOWS_DIR); } catch { return []; }
  const now = Date.now();
  const out: ExternalSession[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(WINDOWS_DIR, file);
    let manifest: WindowManifest | undefined;
    try {
      const raw = await fsp.readFile(fullPath, 'utf8');
      manifest = JSON.parse(raw) as WindowManifest;
    } catch {
      continue;
    }
    if (!manifest || manifest.windowId === this.ownWindowId) continue;
    const age = now - new Date(manifest.lastUpdated).getTime();
    if (age > FRESHNESS_TTL_MS) continue;
    for (const s of manifest.sessions) {
      out.push({ ...s, windowId: manifest.windowId, startedAt: new Date(s.startedAt) });
    }
  }
  return out;
}
```

### Reveal-external round trip

```ts
// sender (window B)
sender.requestFocus(targetWindowId, sessionId);

// writes ~/.claude/claude-code-manager/commands/<targetWindowId>-<rand>.json
// containing { kind: 'focus', sessionId, requestedAt }

// receiver (window A) picks up the file, deletes it, then:
const session = manager.get(sessionId);
if (session) {
  session.terminal.show(false);
  activateVSCodeWindow();           // osascript / wmctrl / WScript.Shell
}
```

## Known Limitations

- **OS window selection on platforms with multiple VS Code windows**. `osascript activate` and friends bring VS Code's most-recent window forward. Because the receiver just called `terminal.show()`, that *is* the window we want. But if the user has been clicking around in other VS Code windows between the focus request being sent and consumed, the platform may pick the wrong one. The session's terminal still gets surfaced *within* the right window once the user gets there.
- **Linux without `wmctrl`**: the receiver activates the terminal in its own window but doesn't bring VS Code forward. Users can install `wmctrl` to fix this; we don't bundle it.
- **Cross-window kill / rename / send**: not supported. Would require a request/response IPC layer with replies; out of scope for #04. External cards intentionally show no controls beyond click-to-reveal.
- **Pid collisions on extreme machine reuse**: theoretically possible if a VS Code extension host exits and another binds the same pid within 30s. Vanishingly unlikely in practice; freshness TTL bounds the failure mode to a single missed cleanup cycle.
- **Older versions of the extension**: a sibling window running a pre-#04 extension won't publish a manifest, and its sessions stay invisible. Upgrade-to-fix.
