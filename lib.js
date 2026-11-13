const path = require("node:path");

// Parses `git worktree list --porcelain`. First entry is always the main worktree.
function parseWorktrees(porcelain) {
  return porcelain
    .split(/\n\n+/)
    .map((block) => {
      const wt = {};
      for (const line of block.split("\n")) {
        const i = line.indexOf(" ");
        const key = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1);
        if (key === "worktree") wt.path = value;
        else if (key === "HEAD") wt.head = value;
        else if (key === "branch") wt.branch = value.replace(/^refs\/heads\//, "");
        else if (key === "bare") wt.bare = true;
      }
      return wt;
    })
    .filter((wt) => wt.path && !wt.bare);
}

// "project" for the main checkout, "project › worktree" otherwise.
// If the worktree folder has the same name as the project, use its parent folder instead.
function worktreeLabel(wtPath, mainPath) {
  const project = path.basename(mainPath);
  if (wtPath === mainPath) return project;
  let name = path.basename(wtPath);
  if (name === project) name = path.basename(path.dirname(wtPath));
  return `${project} › ${name}`;
}

function branchLabel(branch, head) {
  return branch || `detached ${(head || "").slice(0, 7)}`.trim();
}

module.exports = { parseWorktrees, worktreeLabel, branchLabel };

if (require.main === module) {
  const assert = require("node:assert");
  const out = [
    "worktree /a/ai-chatbot-main",
    "HEAD ef76ddc51040aaaa",
    "branch refs/heads/feat/dev-model-picker",
    "",
    "worktree /x/pr242-consolidation/ai-chatbot-main",
    "HEAD 22ec14b6ffff",
    "detached",
    "",
    "worktree /a/ai-chatbot-main/.claude/worktrees/kan-218 with space",
    "HEAD 73e6f0d5",
    "branch refs/heads/feat-raj/kan-218",
    "locked",
    "",
  ].join("\n");
  const wts = parseWorktrees(out);
  assert.equal(wts.length, 3);
  assert.equal(wts[0].branch, "feat/dev-model-picker");
  assert.equal(wts[1].branch, undefined);
  assert.equal(wts[1].head, "22ec14b6ffff");
  assert.equal(wts[2].path, "/a/ai-chatbot-main/.claude/worktrees/kan-218 with space");
  const main = wts[0].path;
  assert.equal(worktreeLabel(main, main), "ai-chatbot-main");
  assert.equal(worktreeLabel(wts[1].path, main), "ai-chatbot-main › pr242-consolidation");
  assert.equal(worktreeLabel(wts[2].path, main), "ai-chatbot-main › kan-218 with space");
  assert.equal(branchLabel(undefined, "22ec14b6ffff"), "detached 22ec14b");
  assert.equal(branchLabel("main", "x"), "main");
  assert.deepEqual(parseWorktrees(""), []);
  console.log("ok");
}
