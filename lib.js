// Pure logic + git calls, no `vscode` import, so test.js can run it under plain node.
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

function runGit(gitPath, cwd, args) {
  return new Promise((resolve, reject) =>
    execFile(gitPath, args, { cwd }, (err, out, stderr) =>
      err ? reject(new Error((stderr || "").trim() || err.message)) : resolve(out)
    )
  );
}

// Parses `git worktree list --porcelain`. First entry is always the main worktree.
function parseWorktrees(porcelain) {
  return porcelain
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const wt = {};
      for (const line of block.split(/\r?\n/)) {
        const i = line.indexOf(" ");
        const key = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1);
        if (key === "worktree") wt.path = value;
        else if (key === "HEAD") wt.head = value;
        else if (key === "branch") wt.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "bare") wt.bare = true;
        else if (key === "locked") wt.locked = true;
        else if (key === "prunable") wt.prunable = true; // folder is gone
      }
      return wt;
    })
    .filter((wt) => wt.path && !wt.bare);
}

const listWorktrees = async (gitPath, cwd) =>
  parseWorktrees(await runGit(gitPath, cwd, ["worktree", "list", "--porcelain"]));

// git prints "C:/x/y", VS Code gives "c:\x\y"; symlinks (/tmp -> /private/tmp) differ too.
// Comparing raw strings would fail to recognise the current worktree and offer to delete it.
function canonical(p) {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {} // missing folder (prunable worktree): fall back to the resolved path
  return process.platform === "win32" ? r.toLowerCase() : r;
}
const samePath = (a, b) => canonical(a) === canonical(b);

// "project" for the main checkout, "project › worktree" otherwise.
// If the worktree folder has the same name as the project, use its parent folder instead.
function worktreeLabel(wtPath, mainPath) {
  const project = path.basename(mainPath);
  if (samePath(wtPath, mainPath)) return project;
  let name = path.basename(wtPath);
  if (name === project) name = path.basename(path.dirname(wtPath));
  return `${project} › ${name}`;
}

function branchLabel(branch, head) {
  return branch || `detached ${(head || "").slice(0, 7)}`.trim();
}

// A detached worktree's commit is safe to drop only if some local or remote branch already contains it.
async function isOnSomeBranch(gitPath, cwd, commit) {
  try {
    const out = await runGit(gitPath, cwd, ["for-each-ref", "--count=1", "--contains", commit, "refs/heads", "refs/remotes"]);
    return out.trim() !== "";
  } catch {
    return false; // can't tell -> assume it would be lost
  }
}

module.exports = { runGit, parseWorktrees, listWorktrees, samePath, worktreeLabel, branchLabel, isOnSomeBranch };
