# Changelog

All notable changes to **Claude Code Manager** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1](https://github.com/graphicfox/claude-code-manager-dashboard/compare/v0.1.0...v0.1.1) (2026-05-04)


### Bug Fixes

* clean out/ before compile to drop stale artifacts ([7e1034f](https://github.com/graphicfox/claude-code-manager-dashboard/commit/7e1034f8ff9c865fba62b0c5b4c7d073381c3551))

## [0.1.0] - 2026-05-04

Initial public release.

### Added
- Sidebar webview (`Claude Code Manager` activity-bar view) listing every running Claude Code session as a card with status pill, folder, and start time.
- Dashboard webview (`Claude: Open Dashboard`) opening in the editor area for at-a-glance session management.
- Status bar indicator (`$(sparkle) Claude: N`) showing active session count, toggleable via `claudeCodeManager.statusBar.enabled`.
- Commands: `New Session`, `New Session in Folder…`, `Focus`, `Send Prompt`, `Rename`, `Kill`, `Kill All`, `Refresh`, `Set Status`, `Restore Saved Sessions`, `Clear Saved Sessions`, `Resume Recent Session…`, `Open Dashboard`.
- Auto-detected session status (Idle / Busy / Question / Permission / Done / Exited) by tailing the JSONL transcript Claude Code writes under `~/.claude/projects/`.
- Auto-rename of sessions to the task title Claude Code derives, with manual renames pinning the name.
- Notifications for sessions needing attention (Question / Permission), with `toast`, `statusBar`, and `none` modes.
- Session persistence across workspace reloads via `workspaceState`, with `ask` / `always` / `never` restore behaviour.
- Configurable CLI path, default args, and shell override for spawned sessions.
