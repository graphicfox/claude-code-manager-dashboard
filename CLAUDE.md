# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`claude-code-manager` is a VS Code extension that manages multiple Claude Code CLI sessions from inside the editor. It exposes a sidebar webview, a fuller dashboard webview, and a status bar item for spawning, focusing, renaming, prompting, status-tracking, and killing `claude` CLI processes — each backed by a dedicated VS Code integrated terminal so the user gets full PTY behaviour for free.

## Development Commands

From [package.json](package.json):

- `npm run compile` — one-shot TypeScript build into [out/](out/) (`tsc -p ./`).
- `npm run watch` — incremental rebuild in watch mode (`tsc -watch -p ./`).
- `npm run package` — produce a `.vsix` via `vsce package` (requires `@vscode/vsce` installed globally).
- `vscode:prepublish` runs `compile` automatically when packaging.

To launch in development: open the folder in VS Code and press **F5** to start the Extension Development Host.

## Architecture

All source lives in [src/](src/) and compiles to [out/](out/) (entry: `./out/extension.js`).

- [src/extension.ts](src/extension.ts) — activation entry point. Wires up the `SessionManager`, registers the `claudeCodeManager.*` commands declared in [package.json](package.json), registers the sidebar webview provider, creates the status bar item, and runs `maybeRestore()` to optionally re-spawn sessions persisted from a previous workspace launch.
- [src/sessionManager.ts](src/sessionManager.ts) — owns the `Map<id, ClaudeSession>` of active sessions. Each session is a `vscode.Terminal` plus metadata (`id`, `name`, `cwd`, `startedAt`, `status: SessionStatus`). `create()` reads config (`cliPath`, `defaultArgs`, `shell`), spawns the terminal with a randomly generated `adjective-animal` name, and `sendText`s the assembled command. Subscribes to `vscode.window.onDidCloseTerminal` so externally-closed terminals are reflected in state. Fires `onDidChange` whenever the session list mutates. Persists `{name, cwd}` per session to `workspaceState` (key `claudeCodeManager.sessions.v1`) on every mutation; a `disposing` flag prevents the close-cascade during shutdown from wiping persistence. Status is intentionally not persisted (ephemeral runtime state).
- [src/sessionWebviewProvider.ts](src/sessionWebviewProvider.ts) — `WebviewViewProvider` for the sidebar (view id `claudeCodeSessions`). Renders sessions as cards with status-tinted backgrounds, a status pill (idle/busy/question/permission/done/exited) with inline-SVG icons, a status-row to mutate state, and an action row (Focus / Send… / Rename / Kill). `rename` and `sendPrompt` open `vscode.window.showInputBox` directly from the message dispatcher rather than going through extra commands. Re-renders on `manager.onDidChange`.
- [src/dashboard.ts](src/dashboard.ts) — singleton `DashboardPanel` webview that opens in the editor area. Receives messages (`newSession`, `focus`, `kill`, `rename`, `sendPrompt`) and delegates to `SessionManager`. Uses the same status-pill styling as the sidebar so both surfaces stay visually consistent.

Sessions are intentionally backed by VS Code integrated terminals rather than child processes — there's no PTY plumbing, and terminal lifecycle hooks keep state in sync.

The terminal API does not expose stdout, so neither webview can stream Claude's output. Status is currently set manually via the sidebar pills or the `claudeCodeManager.setStatus` command. Auto-detection is planned via watching `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, which Claude Code writes for every session — see the design log.

## Tech Stack

- TypeScript ^5.3.3, compiled to CommonJS targeting ES2022 ([tsconfig.json](tsconfig.json)).
- VS Code Extension API ^1.85.0 (`@types/vscode`).
- Node ^20.11.0 types.
- No runtime dependencies — only `devDependencies`.

## Configuration

Extension settings (under `claudeCodeManager.*`, defined in [package.json](package.json)):

- `cliPath` (string, default `"claude"`) — path or command name for the Claude Code CLI.
- `defaultArgs` (string[], default `[]`) — args appended to every spawned session, e.g. `["--model", "claude-opus-4-7"]`.
- `shell` (string, default `""`) — override shell; empty string means use VS Code's integrated terminal default.
- `confirmKill` (boolean, default `true`) — prompt before killing a session.
- `statusBar.enabled` (boolean, default `true`) — show the `$(sparkle) Claude: N` counter in the status bar.
- `restoreOnActivate` (`"ask" | "always" | "never"`, default `"ask"`) — what to do with sessions saved in `workspaceState` on activation.

## Design Log Methodology

This project uses a Design Log Methodology to capture architectural decisions in a way agents can read and extend. **Every non-trivial change should produce a new entry.**

- Location: [.design-log/](.design-log/) — `#NN-Topic_Name.md`.
- Numbering: zero-padded sequential (`#00`, `#01`, …).
- Every entry has frontmatter `alwaysApply: true` so it is loaded into agent context automatically.
- Sections (in order): Background, Problem, Questions and Answers, Design, Implementation Plan, Examples.
- Template: `~/.claude/templates/design-log-entry.md`.

When implementing a new feature or refactor:
1. Read the latest entries in [.design-log/](.design-log/) to understand prior decisions.
2. Append a new entry **before** changing code, capturing Background, Problem, and at least the Design section.
3. Update the entry's Implementation Plan as the work progresses.
4. Cite the entry number in the PR description.

## Conventions

- TypeScript `strict: true` is on — no implicit `any`, exact null checks.
- Single-class-per-file in [src/](src/); each module exports its primary class plus any tightly coupled types (`ClaudeSession`, `SessionStatus`, `PersistedSession`).
- Commands are namespaced `claudeCodeManager.*` and registered centrally in [src/extension.ts](src/extension.ts); their titles, icons, and menu placement live in [package.json](package.json) under `contributes.commands` / `contributes.menus`.
- State changes funnel through `SessionManager` and emit `onDidChange`; UI surfaces (sidebar webview, dashboard, status bar) subscribe rather than poll.
- 2-space indentation, single quotes in TS, double quotes in JSON.
