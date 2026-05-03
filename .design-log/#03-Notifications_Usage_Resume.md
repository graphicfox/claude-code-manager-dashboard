---
description: "Notifications + activity-bar badge for attention states, JSONL-derived usage/cost, and recent-session resume"
alwaysApply: true
---

# Design Log #03: Notifications, Usage, and Resume

## Background

[#02](#02-Status_Auto_Detection.md) wired up automatic status pills, but the pills are passive — you still have to look at the sidebar to know when an agent has stopped to ask you something. The same JSONL we tail also carries token usage on every assistant turn and a per-session UUID, which together open up two adjacent features at no infrastructure cost: cost tracking and conversation resume. This entry covers all three.

## Problem

- **Notifications**: when one of N parallel agents transitions to `question` or `permission`, the user shouldn't have to glance at the sidebar to find out. Need a notification when the transition happens, plus an at-a-glance badge so the activity-bar icon shows how many sessions need attention even when the sidebar isn't focused.
- **Usage / cost**: running multiple parallel Opus sessions burns money quickly. Surface input/output token totals per session and across all sessions, with a USD estimate when the model is recognized.
- **Resume**: Claude Code already writes a JSONL per session, named after the session UUID. The CLI accepts `claude --resume <id>`. Listing recent sessions for the current cwd (sorted by mtime) lets the user pick up an old conversation without remembering its UUID.

## Questions and Answers

- **Q**: Should notifications fire on every entry into an attention state, including bouncing between `busy` and `permission`?
  - **A**: Only on transitions *into* an attention state from a non-attention state. The `permission`-escalation timer needs 10s of `busy` to fire, so back-to-back notifications are naturally throttled. Adding an explicit cooldown is overkill until we see a real-world case where it spams.
- **Q**: How do we render the badge?
  - **A**: `vscode.WebviewView.badge` (a `ViewBadge` with `value` and `tooltip`). VS Code shows it on the activity-bar icon and the view title. Set `undefined` to clear.
- **Q**: What if the badge is set before the user opens the sidebar?
  - **A**: `WebviewView` is undefined until `resolveWebviewView`. The provider caches the desired badge in `pendingBadge` and applies it on resolve.
- **Q**: Where do we get pricing?
  - **A**: Hardcoded `MODEL_PRICING` table for `claude-opus-4-{5,6,7}`, `claude-sonnet-4-{5,6}`, `claude-haiku-4-5`, with cache-read at 0.1× input, 5-minute cache write at 1.25× input, 1-hour cache write at 2× input. Unknown models contribute 0 to cost but their tokens still tally. Prices change — this is a "rough estimate, not an invoice" feature.
- **Q**: When resuming, does Claude Code write to a new JSONL or append to the existing one?
  - **A**: Appends to the same `<sessionId>.jsonl`. That breaks the detector's "first new file in dir wins" claim logic. Fix: when `manager.create()` is called with `resumeSessionId`, pre-set `session.jsonlPath` to the deterministic path; the detector checks `session.jsonlPath` first and skips dir-polling, going straight to tailing the existing file.
- **Q**: Tailing a resumed session reads the full history. Will the status flicker through every past turn?
  - **A**: Yes, briefly — but the final state is correct. Each `setStatus` call clears any pending timers, so we don't end up in a weird intermediate state. Usage accumulates over the full history, which is the *correct* behavior for "show me what this session has cost so far".
- **Q**: How do we extract the title for the resume picker without parsing entire JSONL files?
  - **A**: Read the first 32 KB of each candidate file. That's enough to capture the `ai-title` event (which Claude emits very early) and the first `user` text block (fallback when no title is set). Parse line-by-line, drop the trailing partial line, stop once both are found.

## Design

1. **`onDidChangeStatus` event on `SessionManager`**: payload `{ id, from, to }`. Fires from `setStatus()` whenever status actually changes. The Notifier subscribes to this for transition logic; the existing `onDidChange` keeps firing too for view re-renders.
2. **`SessionUsage` on `ClaudeSession`**: `{ inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, costUsd }`. Initialised to zero in `create()`. `addUsage()` adds a delta and fires `onDidChange`.
3. **Detector extracts usage**: on each `assistant` event, if `message.usage` is present, calls `manager.addUsage(id, { model, ...tokenFields })`. Cache write tokens are split into 5m / 1h via `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`.
4. **`Notifier` class**: subscribes to `onDidChangeStatus`. On transitions into `question` or `permission`, shows a notification per `claudeCodeManager.notifications.mode` (`toast` | `statusBar` | `none`). Toast carries a "Focus" action that calls `manager.focus(id)`. Also subscribes to `onDidChange` to keep the badge count in sync when sessions are added/removed.
5. **Activity-bar badge**: `SessionWebviewProvider.setBadge({value, tooltip})` writes through to `view.badge`, with a `pendingBadge` cache so badges set before the view resolves still appear once the user opens it.
6. **Sidebar usage line**: a small footer below `cwd` showing `<input> in · <output> out · $<cost>` when usage > 0. Hidden when no tokens have been recorded yet.
7. **Dashboard totals strip**: a row above the grid showing aggregate input / output / cost across all live sessions. Hidden when totals are 0.
8. **`claude --resume` integration**: `manager.create()` accepts `resumeSessionId`. When set: prepends `--resume <id>` to args, computes the deterministic `~/.claude/projects/<encoded-cwd>/<id>.jsonl` path and stores it on the session so the detector skips dir-polling.
9. **`recentSessions.ts`**: lists the cwd's `.jsonl` files sorted by mtime, peeks the first 32 KB of each to extract title + first user prompt, returns a list ready for `vscode.window.showQuickPick`.
10. **`Claude: Resume Recent Session…` command**: the only new command. Surfaced in the sidebar title bar between "+ New" and "Open Dashboard".

## Implementation Plan

1. ✅ [src/sessionManager.ts](../src/sessionManager.ts): add `SessionUsage`, `SessionStatusChange`, `_onDidChangeStatus`, `addUsage()`, `resumeSessionId` opt + `jsonlPathFor()` helper. `setStatus()` fires both events.
2. ✅ [src/statusDetector.ts](../src/statusDetector.ts): handle `message.usage` on assistant events. Skip dir-polling when `session.jsonlPath` is pre-set.
3. ✅ Create [src/notifier.ts](../src/notifier.ts) — Notifier class.
4. ✅ [src/sessionWebviewProvider.ts](../src/sessionWebviewProvider.ts): `setBadge` (with `pendingBadge` cache), `usageLine` rendering, plus its CSS.
5. ✅ [src/dashboard.ts](../src/dashboard.ts): totals strip, per-card usage line.
6. ✅ Create [src/recentSessions.ts](../src/recentSessions.ts) — `listRecentSessions()`, `pickRecentLabel()`.
7. ✅ [src/extension.ts](../src/extension.ts): instantiate `Notifier`, register `claudeCodeManager.resumeSession`.
8. ✅ [package.json](../package.json): `notifications.mode` config, `resumeSession` command + view-title placement.

## Examples

### Status change event + Notifier

```ts
// sessionManager.ts
setStatus(id: string, status: SessionStatus): void {
  const session = this.sessions.get(id);
  if (!session) return;
  if (session.status === status) return;
  const from = session.status;
  session.status = status;
  this._onDidChangeStatus.fire({ id, from, to: status });
  this._onDidChange.fire();
}

// notifier.ts
manager.onDidChangeStatus((change) => {
  if (
    ATTENTION_STATES.includes(change.to) &&
    !ATTENTION_STATES.includes(change.from)
  ) {
    void this.notify(change.id, change.to);
  }
  this.updateBadge();
});
```

### Resume short-circuit

```ts
// sessionManager.ts: create()
const knownJsonlPath = opts.resumeSessionId
  ? this.jsonlPathFor(cwd, opts.resumeSessionId)
  : undefined;
// ... session is constructed with jsonlPath: knownJsonlPath

// statusDetector.ts: attach()
if (session.jsonlPath) {
  watch.jsonlPath = session.jsonlPath;
  await this.beginTail(watch);
} else {
  this.beginPolling(watch);
}
```

## Known Limitations

- **Pricing table is hardcoded**. Anthropic price changes will silently make the cost figure wrong until we update the table. The number is explicitly an estimate.
- **Multi-root workspaces**: resume command picks `workspaceFolders[0]` for the cwd. Fine for single-root, suboptimal for multi-root.
- **Notification spam under pathological scenarios**: if a session bounces between busy and permission rapidly (e.g. a long Bash command that occasionally completes a chunk, but the 10s timer keeps re-firing), each entry into `permission` will notify. In practice the 10s threshold makes this rare.
- **Resume picker is single-cwd**: lists prior sessions for the current workspace folder only. Would need a "browse all projects" mode to surface unrelated past work — punted for now.
