// Run: node --test   (no deps; integration tests drive real git in a temp dir)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const lib = require("./lib");

test("parseWorktrees: branch, detached, spaces, locked, prunable, bare, CRLF", () => {
  const out = [
    "worktree /a/app",
    "HEAD ef76ddc51040aaaa",
    "branch refs/heads/feat/picker",
    "",
    "worktree /x/pr242/app",
    "HEAD 22ec14b6ffff",
    "detached",
    "",
    "worktree /a/app/.claude/worktrees/kan 218",
    "HEAD 73e6f0d5",
    "branch refs/heads/feat/kan-218",
    "locked some reason",
    "",
    "worktree /gone",
    "HEAD 1111111",
    "detached",
    "prunable gitdir file points to non-existent location",
    "",
  ].join("\n");
  const wts = lib.parseWorktrees(out);
  assert.equal(wts.length, 4);
  assert.equal(wts[0].branch, "feat/picker");
  assert.equal(wts[1].branch, undefined);
  assert.equal(wts[1].head, "22ec14b6ffff");
  assert.equal(wts[2].path, "/a/app/.claude/worktrees/kan 218");
  assert.equal(wts[2].locked, true);
  assert.equal(wts[3].prunable, true);
  assert.deepEqual(lib.parseWorktrees(out.replace(/\n/g, "\r\n")), wts);
  assert.deepEqual(lib.parseWorktrees("worktree /repo.git\nbare\n\n"), []);
  assert.deepEqual(lib.parseWorktrees(""), []);
});

test("worktreeLabel / branchLabel", () => {
  assert.equal(lib.worktreeLabel("/a/app", "/a/app"), "app");
  assert.equal(lib.worktreeLabel("/a/app/", "/a/app"), "app"); // trailing slash is still main
  assert.equal(lib.worktreeLabel("/x/pr242/app", "/a/app"), "app › pr242"); // same folder name -> parent
  assert.equal(lib.worktreeLabel("/a/wt/kan 218", "/a/app"), "app › kan 218");
  assert.equal(lib.branchLabel(undefined, "22ec14b6ffff"), "detached 22ec14b");
  assert.equal(lib.branchLabel(undefined, undefined), "detached");
  assert.equal(lib.branchLabel("main", "x"), "main");
});

test("samePath: symlinks, normalisation, and Windows-style git paths", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wts-")));
  const link = dir + "-link";
  fs.symlinkSync(dir, link, "dir");
  try {
    assert.ok(lib.samePath(dir, link));
    assert.ok(lib.samePath(dir, path.join(dir, "sub", "..")));
    assert.ok(!lib.samePath(dir, path.join(dir, "sub")));
    if (process.platform === "win32") assert.ok(lib.samePath(dir.replace(/\\/g, "/").toUpperCase(), dir));
  } finally {
    fs.rmSync(link);
    fs.rmSync(dir, { recursive: true });
  }
});

// Real git: guards against git changing its porcelain/error text under us.
test("git integration", async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wts-git-")));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const main = path.join(tmp, "app");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  fs.mkdirSync(main);
  git(main, "init", "-q");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", path.join(tmp, "with branch"), "-b", "feature");
  git(main, "worktree", "add", "-q", "--detach", path.join(tmp, "detached"));
  git(path.join(tmp, "detached"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "orphan");
  const orphan = git(path.join(tmp, "detached"), "rev-parse", "HEAD").trim();
  const onMain = git(main, "rev-parse", "HEAD").trim();
  // git sorts linked worktrees by name, so look them up by folder rather than index
  const find = (wts, name) => wts.find((w) => path.basename(w.path) === name);

  await t.test("lists worktrees from any of them, main first", async () => {
    const wts = await lib.listWorktrees("git", path.join(tmp, "with branch"));
    assert.equal(wts.length, 3);
    assert.ok(lib.samePath(wts[0].path, main));
    assert.equal(find(wts, "with branch").branch, "feature");
    assert.equal(find(wts, "detached").branch, undefined);
    assert.equal(find(wts, "detached").head, orphan);
  });

  await t.test("isOnSomeBranch", async () => {
    assert.equal(await lib.isOnSomeBranch("git", main, onMain), true);
    assert.equal(await lib.isOnSomeBranch("git", main, orphan), false);
    assert.equal(await lib.isOnSomeBranch("git", main, "deadbeef"), false); // unknown -> assume lost
  });

  await t.test("dirty worktree: plain remove refuses with a --force hint (extension relies on it)", async () => {
    fs.writeFileSync(path.join(tmp, "with branch", "untracked.txt"), "x");
    await assert.rejects(lib.runGit("git", main, ["worktree", "remove", path.join(tmp, "with branch")]), /--force/);
  });

  await t.test("locked worktree: error has no --force hint, so no Force Delete is offered", async () => {
    git(main, "worktree", "lock", path.join(tmp, "detached"));
    const err = await lib.runGit("git", main, ["worktree", "remove", path.join(tmp, "detached")]).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.doesNotMatch(err.message, /--force/);
    const wts = await lib.listWorktrees("git", main);
    assert.equal(find(wts, "detached").locked, true);
    git(main, "worktree", "unlock", path.join(tmp, "detached"));
  });

  await t.test("missing folder shows as prunable and can still be removed", async () => {
    fs.rmSync(path.join(tmp, "detached"), { recursive: true });
    let wts = await lib.listWorktrees("git", main);
    assert.equal(find(wts, "detached").prunable, true);
    await lib.runGit("git", main, ["worktree", "remove", find(wts, "detached").path]);
    wts = await lib.listWorktrees("git", main);
    assert.equal(wts.length, 2);
  });

  await t.test("runGit surfaces git's stderr", async () => {
    await assert.rejects(lib.runGit("git", tmp, ["worktree", "list"]), /not a git repository/);
  });
});
