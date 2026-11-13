const vscode = require("vscode");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { parseWorktrees, worktreeLabel, branchLabel } = require("./lib");

function runGit(cwd, args) {
  return new Promise((resolve, reject) =>
    execFile("git", args, { cwd }, (err, out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(out)
    )
  );
}

const listWorktrees = async (cwd) => parseWorktrees(await runGit(cwd, ["worktree", "list", "--porcelain"]));

// Deletes the worktree folder only; its branch is kept. Never offered for the main or current worktree.
// A detached worktree's commit is safe only if some local or remote branch already contains it.
async function isOnSomeBranch(cwd, commit) {
  try {
    const out = await runGit(cwd, ["for-each-ref", "--count=1", "--contains", commit, "refs/heads", "refs/remotes"]);
    return out.trim() !== "";
  } catch {
    return false; // can't tell -> assume it would be lost
  }
}

async function deleteWorktree(cwd, item) {
  const short = item.head.slice(0, 7);
  const lost = item.detached && !(await isOnSomeBranch(cwd, item.head));
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
    await runGit(cwd, ["worktree", "remove", item.path]);
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
      await runGit(cwd, ["worktree", "remove", "--force", item.path]);
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
  const git = (await vscode.extensions.getExtension("vscode.git").activate()).getAPI(1);

  const wtItem = vscode.window.createStatusBarItem("worktreeSwitcher.worktree", vscode.StatusBarAlignment.Left, 10100);
  wtItem.name = "Worktree";
  wtItem.command = "worktreeSwitcher.pick";
  wtItem.tooltip = "Switch worktree";

  context.subscriptions.push(wtItem);

  const mainPaths = new Map(); // repo root -> main worktree path (never changes)
  const repo = () => git.repositories[0];

  const update = async () => {
    const r = repo();
    if (!r) {
      wtItem.hide();
      return;
    }
    const root = r.rootUri.fsPath;
    if (!mainPaths.has(root)) {
      const wts = await listWorktrees(root).catch(() => []);
      mainPaths.set(root, wts[0]?.path ?? root);
    }
    wtItem.text = `$(repo) ${worktreeLabel(root, mainPaths.get(root))}`;
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
        wts = await listWorktrees(root);
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
        const deletable = i !== 0 && wt.path !== root;
        return {
          label: `${wt.path === root ? "$(check)" : "$(blank)"} ${name}`,
          description: `$(git-branch) ${branch}`,
          detail: wt.path.replace(os.homedir(), "~"),
          path: wt.path,
          name,
          branch,
          head: wt.head || "",
          detached: !wt.branch,
          buttons: deletable ? [newWindowBtn, deleteBtn] : [newWindowBtn],
        };
      });
      const open = (item, forceNewWindow) => {
        qp.hide();
        if (!item || (item.path === root && !forceNewWindow)) return;
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(item.path), { forceNewWindow });
      };
      qp.onDidAccept(() => open(qp.selectedItems[0], false));
      qp.onDidTriggerItemButton((e) => {
        if (e.button !== deleteBtn) return open(e.item, true);
        qp.hide();
        deleteWorktree(root, e.item);
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    })
  );

  await update();
}

module.exports = { activate };
