const vscode = require("vscode");
const os = require("node:os");
const lib = require("./lib");
const { samePath, worktreeLabel, branchLabel } = lib;

// Deletes the worktree folder only; its branch is kept. Never offered for the main or current worktree.
async function deleteWorktree(gitPath, cwd, item) {
  const runGit = (args) => lib.runGit(gitPath, cwd, args);
  const short = item.head.slice(0, 7);
  const lost = item.detached && !(await lib.isOnSomeBranch(gitPath, cwd, item.head));
  const choice = lost ? "Delete and Lose Commits" : "Delete";
  const ok = await vscode.window.showWarningMessage(
    lost ? `"${item.name}" has commits that are not on any branch.` : `Delete worktree "${item.name}"?`,
    {
      modal: true,
      detail: lost
        ? `Commit ${short} is not on any branch. Deleting this worktree will lose it.\n` +
          `To keep it, cancel and run in that folder:\n  git switch -c <new-branch-name>`
        : item.detached
          ? `Removes the folder ${item.detail}\nIts commit ${short} is already on a branch, so nothing is lost.`
          : `Removes the folder ${item.detail}\nThe branch "${item.branch}" is kept.`,
    },
    choice
  );
  if (ok !== choice) return;
  try {
    await runGit(["worktree", "remove", item.path]);
  } catch (err) {
    // Git refuses when there are uncommitted or untracked files; anything else (e.g. locked) is just reported.
    if (!err.message.includes("--force")) {
      vscode.window.showErrorMessage(`Could not delete worktree: ${err.message}`);
      return;
    }
    const force = await vscode.window.showWarningMessage(
      `"${item.name}" has uncommitted or untracked changes.`,
      { modal: true, detail: "Force Delete removes the folder and permanently discards those changes." },
      "Force Delete"
    );
    if (force !== "Force Delete") return;
    try {
      await runGit(["worktree", "remove", "--force", item.path]);
    } catch (err2) {
      vscode.window.showErrorMessage(`Could not delete worktree: ${err2.message}`);
      return;
    }
  }
  vscode.window.showInformationMessage(
    item.detached ? `Deleted worktree "${item.name}".` : `Deleted worktree "${item.name}". Branch "${item.branch}" kept.`
  );
}

async function activate(context) {
  let git;
  try {
    git = (await vscode.extensions.getExtension("vscode.git").activate()).getAPI(1);
  } catch {
    return; // ponytail: "git.enabled": false -> stay inactive until next reload
  }
  const gitPath = git.git.path;

  const wtItem = vscode.window.createStatusBarItem("worktreeSwitcher.worktree", vscode.StatusBarAlignment.Left, 10100);
  wtItem.name = "Worktree";
  wtItem.command = "worktreeSwitcher.pick";
  wtItem.tooltip = "Switch worktree";

  context.subscriptions.push(wtItem);

  const mainPaths = new Map(); // repo root -> main worktree path (never changes)
  // The repo of this window's folder, not whichever repo (e.g. a submodule) the git extension found first.
  const repo = () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return (folder && git.getRepository(folder.uri)) || git.repositories[0];
  };

  const update = async () => {
    const r = repo();
    if (!r) {
      wtItem.hide();
      return;
    }
    const root = r.rootUri.fsPath;
    if (!mainPaths.has(root)) {
      // Only cache a real answer; a transient git failure must not pin the wrong label forever.
      const wts = await lib.listWorktrees(gitPath, root).catch(() => []);
      if (wts[0]) mainPaths.set(root, wts[0].path);
    }
    wtItem.text = `$(repo) ${worktreeLabel(root, mainPaths.get(root) ?? root)}`;
    wtItem.show();
  };

  const watch = (r) => context.subscriptions.push(r.state.onDidChange(update));
  git.repositories.forEach(watch);
  context.subscriptions.push(
    git.onDidOpenRepository((r) => {
      watch(r);
      update();
    }),
    git.onDidCloseRepository(update)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("worktreeSwitcher.pick", async () => {
      const r = repo();
      if (!r) return;
      const root = r.rootUri.fsPath;
      let wts;
      try {
        wts = await lib.listWorktrees(gitPath, root);
      } catch (err) {
        vscode.window.showErrorMessage(`git worktree list failed: ${err.message}`);
        return;
      }
      const qp = vscode.window.createQuickPick();
      qp.placeholder = "Switch worktree (Enter: this window, buttons: new window / delete)";
      qp.matchOnDescription = true;
      qp.matchOnDetail = true;
      const newWindowBtn = { iconPath: new vscode.ThemeIcon("empty-window"), tooltip: "Open in new window" };
      const deleteBtn = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Delete worktree (keeps branch)" };
      qp.items = wts.map((wt, i) => {
        const name = worktreeLabel(wt.path, wts[0].path);
        const branch = branchLabel(wt.branch, wt.head);
        const current = samePath(wt.path, root);
        const deletable = i !== 0 && !current;
        const home = os.homedir();
        const shown = wt.path.startsWith(home) ? "~" + wt.path.slice(home.length) : wt.path;
        return {
          label: `${current ? "$(check)" : "$(blank)"} ${name}`,
          description: `$(git-branch) ${branch}${wt.locked ? "  $(lock) locked" : ""}`,
          detail: wt.prunable ? `${shown}  (folder missing)` : shown,
          current,
          prunable: !!wt.prunable,
          path: wt.path,
          name,
          branch,
          head: wt.head || "",
          detached: !wt.branch,
          buttons: [...(wt.prunable ? [] : [newWindowBtn]), ...(deletable ? [deleteBtn] : [])],
        };
      });
      const open = (item, forceNewWindow) => {
        qp.hide();
        if (!item || (item.current && !forceNewWindow)) return;
        if (item.prunable) {
          vscode.window.showErrorMessage(`Folder for "${item.name}" no longer exists. Delete it from the list to clean up.`);
          return;
        }
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(item.path), { forceNewWindow });
      };
      qp.onDidAccept(() => open(qp.selectedItems[0], false));
      qp.onDidTriggerItemButton((e) => {
        if (e.button !== deleteBtn) return open(e.item, true);
        qp.hide();
        deleteWorktree(gitPath, root, e.item);
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );

  await update();
}

module.exports = { activate };
