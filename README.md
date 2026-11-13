# Worktree Switcher

Zed-style git worktree switcher for VS Code.

- Status bar (far left): `project › worktree`. Click to list all worktrees with their branch.
- Enter opens a worktree in this window; the window button opens it in a new window.
- Trash button deletes a worktree (never the main checkout or the current one):
  - always asks to confirm; the branch is kept
  - git refuses if there are uncommitted/untracked files; "Force Delete" is a second, explicit step
  - detached worktrees whose commit is on no branch get a "Delete and Lose Commits" warning

## Install

- VS Code: `ext install rajtiwariee.worktree-switcher` (Quick Open, Cmd/Ctrl+P), or search "Worktree Switcher" in Extensions.
- Cursor / Windsurf / VSCodium: install from [Open VSX](https://open-vsx.org/extension/rajtiwariee/worktree-switcher).

## Build from source

```sh
npx @vscode/vsce package
code --install-extension worktree-switcher-*.vsix --force
```

Then run "Developer: Reload Window".

## Pairs well with (user settings)

```json
"window.title": "${rootName}  ⎇ ${activeRepositoryBranchName}${separator}${activeEditorShort}${dirty}",
"window.commandCenter": false
```
