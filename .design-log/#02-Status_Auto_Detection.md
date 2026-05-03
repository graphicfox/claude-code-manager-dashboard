---
description: "Auto-detect session status and task name by tailing Claude Code's JSONL session logs"
alwaysApply: true
---

# Design Log #02: Status Auto-Detection via JSONL

## Background

[#01](#01-Sidebar_Status_And_Persistence.md) shipped the visual scaffolding for a richer six-state status (`idle | busy | question | permission | done | exited`) and random adjective-animal session names, but every status change required the user to click a pill in the sidebar. That defeats the point — the value of the extension is glanceable status across many parallel agents, which only works if the status updates on its own.

VS Code's terminal API does not expose stdout to the extension host, so the integrated terminal route is a dead end for status detection. However, Claude Code itself records every session event to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each line is a JSON object with a `type` discriminator (`user`, `assistant`, `system`, `ai-title`, `queue-operation`, etc.). That log is the source of truth.

## Problem

- Need to attach a session-id-less running terminal to the JSONL file Claude eventually writes for it. We don't know the JSONL path at spawn time — Claude generates the session UUID itself.
- Need to derive the five user-meaningful statuses from event types we cannot fully categorise in advance.
- Need to keep the existing manual override path working so the user can correct the heuristic.
- Need an automatic task-name takeover: replace `fuzzy-dragon` with the `aiTitle` Claude Code emits, but pin the name once the user manually renames.

## Questions and Answers

- **Q**: How is the cwd encoded into the project directory name?
  - **A**: All `/` and `\` are replaced with `-`. So `/Users/kim/Work/claude-code-manager` → `-Users-kim-Work-claude-code-manager`. Verified by listing `~/.claude/projects/`.
- **Q**: How do we map a spawned terminal to its JSONL file when the path isn't known at spawn time?
  - **A**: Snapshot the existing JSONL filenames in the cwd's project dir at spawn time (`knownFiles`). Poll the dir at 1s intervals; the first new file that appears is claimed. Multiple-files-at-once is broken by mtime (most recently modified wins). Documented limitation: spawning two sessions in the same cwd within the same poll window can swap their files.
- **Q**: How do we tell Busy from Permission from a long-running tool?
  - **A**: We can't, exactly. The JSONL records events that have been committed; a pending permission prompt sits in the TUI before being written. Heuristic: enter `busy` on `assistant.stop_reason: tool_use`; arm a 10s timer; if still in `busy` when it fires, escalate to `permission`. Long-running Bash commands trip this — the user can flip back manually. Configurable threshold isn't worth adding yet.
- **Q**: Is `done` redundant with `idle`?
  - **A**: Briefly distinct. `assistant.stop_reason: end_turn` sets `done`; the matching `system.subtype: stop_hook_summary` (which fires on every turn end if any Stop hooks are configured, which they are by default in our test env) overrides to `idle` very shortly after. A 4s fade timer handles the case where stop hooks are disabled — without it the pill would be stuck on Done forever.
- **Q**: When does the detector consider an `ai-title` authoritative?
  - **A**: Always, as long as the user hasn't manually renamed the session. `SessionManager` carries a `manuallyRenamed` flag, persisted across reloads. `rename()` sets it to true; `autoRename()` checks and skips if true.
- **Q**: Do we need to read the JSONL from the start, or only from where we attached?
  - **A**: From the start. The first read sweeps any events written before our watcher attached (Claude Code typically writes a few events in the first ~500ms). The accumulated buffer + tail-by-byte-offset pattern means we never miss or double-process an event.

## Design

1. **`StatusDetector` class**: implements `vscode.Disposable`, owned by the extension activation closure and pushed onto `context.subscriptions`. Subscribes to `SessionManager.onDidChange` to attach watchers for new sessions and detach for removed ones. Also reacts to changes in `claudeCodeManager.autoStatus.enabled`.
2. **Per-session `SessionWatch`**: holds the cwd's project dir, the snapshot of pre-existing JSONL filenames, the eventual `jsonlPath`, a tail byte offset and partial-line buffer, and a handful of timers (dir poll, file watcher, permission escalation, done fade).
3. **Two-phase attach**: phase 1 polls the cwd's project dir at 1s for a new JSONL; phase 2 (after claim) tails the file with `fs.watch`, falling back to `setInterval` polling on platforms where `fs.watch` is unreliable.
4. **Event mapping** (the latest event determines current status):
   - `user` → `busy`
   - `assistant` with `tool_use` content named `AskUserQuestion` → `question`
   - `assistant` with `stop_reason: end_turn` → `done` (then 4s fade to `idle`)
   - `assistant` with `stop_reason: tool_use` → `busy` (10s timer escalates to `permission`)
   - `assistant` other → `busy`
   - `system` with `subtype: stop_hook_summary` → `idle`
   - `ai-title` → `manager.autoRename()` (no status change)
   - everything else (`queue-operation`, `attachment`, `file-history-snapshot`, `last-prompt`) → ignored
5. **Read coalescing**: `fs.watch` can fire many times during a single write burst. The detector guards `readNew` with a `reading` flag and a `pendingRead` boomerang so concurrent triggers collapse into one drained read.
6. **Truncation handling**: if `stat.size < byteOffset`, reset offset and buffer (covers log rotation).
7. **`manuallyRenamed` plumbing**: added to `ClaudeSession`, persisted in `PersistedSession` (optional, omitted when false), restored by `restorePersisted()`. `rename()` sets it; `autoRename()` checks it.
8. **Two new config keys**: `claudeCodeManager.autoStatus.enabled` (default true) and `claudeCodeManager.autoRename.enabled` (default true), so the user can fall back to fully manual if the heuristic misfires.

## Implementation Plan

1. ✅ `SessionManager`: add `manuallyRenamed` to the session model and the persisted record. Add `autoRename(id, name)` (refuses when manually renamed) and `setJsonlPath(id, path)` (internal bookkeeping). `rename()` sets `manuallyRenamed = true`.
2. ✅ Create [src/statusDetector.ts](../src/statusDetector.ts).
3. ✅ Wire the detector into [src/extension.ts](../src/extension.ts) activation; add to `context.subscriptions`.
4. ✅ Add `autoStatus.enabled` and `autoRename.enabled` to [package.json](../package.json) configuration.

## Examples

### Status mapping

```ts
// statusDetector.ts
case 'assistant': {
  const stopReason = event.message?.stop_reason;
  const hasAskQuestion = (event.message?.content ?? []).some(
    (c) => c?.type === 'tool_use' && c?.name === 'AskUserQuestion'
  );
  if (hasAskQuestion) {
    this.setStatus(watch, 'question');
  } else if (stopReason === 'end_turn') {
    this.setStatus(watch, 'done');
    this.queueDoneFade(watch);
  } else if (stopReason === 'tool_use') {
    this.setStatus(watch, 'busy');
    this.queuePermissionEscalation(watch);
  }
  break;
}
```

### Manual-rename pin

```ts
// sessionManager.ts
rename(id: string, newName: string): void {
  const session = this.sessions.get(id);
  if (!session) return;
  session.name = newName;
  session.manuallyRenamed = true; // pinned — autoRename will skip from now on
  this.persist();
  this._onDidChange.fire();
}

autoRename(id: string, newName: string): void {
  const session = this.sessions.get(id);
  if (!session || session.manuallyRenamed) return;
  if (session.name === newName) return;
  session.name = newName;
  this.persist();
  this._onDidChange.fire();
}
```

## Known Limitations

- **Two new sessions in the same cwd within the same 1s poll window** can have their JSONL files swapped. Status will still update sensibly per the events written by Claude, but the names may be wrong. Acceptable for v1.
- **Long-running tool calls (>10s) get flagged as `permission`**. The user manually flipping back is the correction path. A smarter heuristic (per-tool thresholds, or actually monitoring the TUI's permission prompt state) would require a different detection path.
- **Custom shell prompts that delay `claude` startup** can leave the `dir poll` running for >1s before claiming. Detector recovers automatically once the JSONL appears.
