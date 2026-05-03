---
description: "Design log for the initial state of claude-code-manager"
alwaysApply: true
---

# Design Log #00: Initial Design

## Background

`claude-code-manager` is a VS Code extension (TypeScript, targeting VS Code ^1.85) that manages multiple Claude Code CLI sessions from inside the editor. The current state of the codebase implements a sidebar `TreeView` (`claudeCodeSessions`) plus a singleton webview `DashboardPanel`, both backed by a `SessionManager` that owns each session as a `vscode.Terminal` rather than a child process. Configuration lives under `claudeCodeManager.*` (`cliPath`, `defaultArgs`, `shell`, `confirmKill`) and commands are namespaced the same way. There are no runtime dependencies — only `typescript`, `@types/node`, and `@types/vscode` as devDependencies — and compilation is a plain `tsc -p ./` into [out/](../out/). This entry establishes the baseline so subsequent design log entries can reference "the initial design" rather than reconstructing it from `git log`.

## Problem
<Concrete problem being solved. Bullet specific gaps, missing behaviour, or user pain points.>

## Questions and Answers
- **Q**: <Open question that came up while designing this>
  - **A**: <Resolution. Cite file paths, function names, schema columns where relevant.>
- **Q**: <Next question>
  - **A**: <Answer>

## Design
1. **<Decision name>**: <One-line description, then 1–3 lines of detail.>
2. **<Decision name>**: <…>
3. **<Decision name>**: <…>

## Implementation Plan
1. <Concrete step pointing to a file or function. e.g. "Add `canCreateEvent` flag in `+page.server.ts`'s `load`.">
2. <…>
3. <…>

## Examples
### <Subsection name, e.g. "Dynamic Event Badge State">
```ts
// Real-or-pseudocode showing the shape of the change.
```
