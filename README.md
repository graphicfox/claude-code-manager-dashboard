# Claude Code Manager

A VS Code extension to manage multiple **Claude Code** CLI sessions from a sidebar and dashboard.

## What it does

- 🪐 **Sidebar tree view** of every running Claude session with status, folder, and start time
- 🚀 **One-click new sessions**, optionally in any folder you pick
- 🎯 **Focus** any terminal, **rename** sessions, **send prompts** without switching panes
- 📊 **Dashboard webview** with a card per session for at-a-glance management
- ⚙️ **Configurable** CLI path, default args, shell, and kill confirmation
- 🧹 **Kill all** active sessions in one command
- 🔄 Auto-detects when a terminal is closed externally and updates state

## Install (development)

```bash
cd claude-code-manager
npm install
npm run compile
```

Open this folder in VS Code and press **F5** to launch the Extension Development Host.

## Package as `.vsix`

```bash
npm install -g @vscode/vsce
vsce package
```

This produces `claude-code-manager-0.1.0.vsix`. Install it via:

```bash
code --install-extension claude-code-manager-0.1.0.vsix
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudeCodeManager.cliPath` | `claude` | Path or command name for the Claude Code CLI |
| `claudeCodeManager.defaultArgs` | `[]` | Args passed to every spawned session |
| `claudeCodeManager.shell` | `""` | Override shell (empty = VS Code default) |
| `claudeCodeManager.confirmKill` | `true` | Prompt before killing a session |

## Commands

All commands are accessible via the Command Palette under **Claude:**

- `Claude: New Session`
- `Claude: New Session in Folder...`
- `Claude: Focus Session`
- `Claude: Send Prompt to Session`
- `Claude: Rename Session`
- `Claude: Kill Session`
- `Claude: Kill All Sessions`
- `Claude: Open Dashboard`
- `Claude: Refresh Sessions`

## Architecture

```
src/
├── extension.ts       # Activation, command registration
├── sessionManager.ts  # Session lifecycle (terminals as sessions)
├── sessionTree.ts     # Sidebar TreeDataProvider
└── dashboard.ts       # Webview panel
```

Sessions are backed by VS Code integrated terminals — no child-process management headaches, and the user gets full PTY behavior for free. The manager listens for `onDidCloseTerminal` to keep its state in sync if a user closes a terminal manually.

## Notes

- Requires the Claude Code CLI to be installed and on `PATH` (or set `cliPath`).
- The webview cannot stream terminal output (terminals are owned by VS Code's renderer); the dashboard manages sessions but you read output in the terminal pane itself.
