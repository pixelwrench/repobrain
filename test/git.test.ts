import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitDiff,
  defaultBranch,
  fetchQuietly,
  fileAt,
  firstParentCommits,
  isAncestor,
  mergeBase,
  revParse,
  repoRoots,
  toplevel,
} from "../src/git.js";
import { commit, makeRepo, sh, tempDir } from "./helpers.js";

describe("git helpers", () => {
  it("uses the local branch when there is no remote", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    expect(defaultBranch(repo)).toBe("master");
  });

  it("prefers a local main or master over the current branch when there is no remote", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, { "b.txt": "b\n" }, "wip");
    expect(defaultBranch(repo)).toBe("master");
    sh(repo, ["branch", "-q", "main", "master"]);
    expect(defaultBranch(repo)).toBe("main");
  });

  it("uses init.defaultBranch's branch when it exists", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["branch", "-m", "trunk"]);
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    sh(repo, ["config", "init.defaultBranch", "trunk"]);
    expect(defaultBranch(repo)).toBe("trunk");
  });

  it("uses the current branch, or null for a detached HEAD, when no default exists", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["branch", "-m", "trunk"]);
    expect(defaultBranch(repo)).toBe("trunk");
    sh(repo, ["checkout", "-q", "--detach"]);
    expect(defaultBranch(repo)).toBeNull();
  });

  it("prefers the remote default branch", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    const bare = tempDir("codebrain-bare-");
    sh(bare, ["init", "-q", "--bare"]);
    sh(repo, ["remote", "add", "origin", bare]);
    sh(repo, ["push", "-q", "origin", "master"]);
    sh(repo, ["fetch", "-q", "origin"]);
    expect(defaultBranch(repo)).toBe("origin/master");
  });

  it("lists first-parent commits oldest first, so a merged branch appears once", () => {
    const repo = makeRepo();
    const root = commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, { "b.txt": "b\n" }, "feature one");
    commit(repo, { "c.txt": "c\n" }, "feature two");
    sh(repo, ["checkout", "-q", "master"]);
    sh(repo, ["merge", "-q", "--no-ff", "feature", "-m", "Merge feature"]);
    const commits = firstParentCommits(repo, root, "master");
    expect(commits.map((c) => c.title)).toEqual(["Merge feature"]);
  });

  it("diffs a merge against its first parent and honours excludes", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, { "src/b.ts": "export const b = 1;\n", "package-lock.json": "{}\n" }, "feature");
    sh(repo, ["checkout", "-q", "master"]);
    sh(repo, ["merge", "-q", "--no-ff", "feature", "-m", "Merge feature"]);
    const diff = commitDiff(repo, revParse(repo, "HEAD"), ["**/package-lock.json"]);
    expect(diff).toContain("src/b.ts");
    expect(diff).not.toContain("package-lock.json");
  });

  it("diffs a root commit", () => {
    const repo = makeRepo();
    const root = commit(repo, { "a.txt": "hello\n" }, "first");
    expect(commitDiff(repo, root, [])).toContain("+hello");
  });

  it("detects rewritten history", () => {
    const repo = makeRepo();
    const a = commit(repo, { "a.txt": "a\n" }, "a");
    const b = commit(repo, { "b.txt": "b\n" }, "b");
    sh(repo, ["reset", "-q", "--hard", a]);
    const c = commit(repo, { "c.txt": "c\n" }, "c");
    expect(isAncestor(repo, b, c)).toBe(false);
    expect(mergeBase(repo, b, c)).toBe(a);
  });

  it("ignores the developer's global git config", () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("returns false when fetching from a dead remote", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["remote", "add", "origin", path.join(tempDir("codebrain-gone-"), "missing")]);
    expect(fetchQuietly(repo)).toBe(false);
  });

  it("uses origin/HEAD when it is set", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["branch", "-m", "main"]);
    const bare = tempDir("codebrain-bare-");
    sh(bare, ["init", "-q", "--bare", "-b", "main"]);
    sh(repo, ["remote", "add", "origin", bare]);
    sh(repo, ["push", "-q", "origin", "main"]);
    sh(repo, ["remote", "set-head", "origin", "-a"]);
    expect(sh(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).toBe("origin/main");
    expect(defaultBranch(repo)).toBe("origin/main");
  });

  it("falls back to origin/main when origin/HEAD dangles", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    sh(repo, ["branch", "-m", "main"]);
    const bare = tempDir("codebrain-bare-");
    sh(bare, ["init", "-q", "--bare", "-b", "main"]);
    sh(repo, ["remote", "add", "origin", bare]);
    sh(repo, ["push", "-q", "origin", "main"]);
    sh(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master"]);
    expect(defaultBranch(repo)).toBe("origin/main");
  });

  it("returns null for a shallow boundary commit instead of diffing the whole tree", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    commit(repo, { "b.txt": "b\n" }, "second");
    const clone = path.join(tempDir("codebrain-clone-"), "c");
    sh(repo, ["clone", "-q", "--depth", "1", `file://${repo}`, clone]);
    expect(commitDiff(clone, revParse(clone, "HEAD"), [])).toBeNull();
  });

  it("returns null when the diff is larger than maxBytes", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "a.txt": "x".repeat(500) + "\n" }, "first");
    expect(commitDiff(repo, sha, [], 100)).toBeNull();
    expect(commitDiff(repo, sha, [])).toContain("a.txt");
  });

  it("keeps a/ b/ headers whatever the repo's diff config says", () => {
    const repo = makeRepo();
    const root = commit(repo, { "a.txt": "a\n" }, "first");
    const next = commit(repo, { "a.txt": "b\n" }, "second");
    sh(repo, ["config", "diff.noprefix", "true"]);
    sh(repo, ["config", "diff.mnemonicPrefix", "true"]);
    expect(commitDiff(repo, root, [])).toContain("diff --git a/a.txt b/a.txt");
    expect(commitDiff(repo, next, [])).toContain("diff --git a/a.txt b/a.txt");
  });

  it("excludes a root-level file", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "a.txt": "a\n", "package-lock.json": "{}\n" }, "first");
    const diff = commitDiff(repo, sha, ["package-lock.json"]);
    expect(diff).toContain("a.txt");
    expect(diff).not.toContain("package-lock.json");
  });

  it("limits commits by date when there is no starting commit", () => {
    const repo = makeRepo();
    const saved = process.env.GIT_COMMITTER_DATE;
    try {
      process.env.GIT_COMMITTER_DATE = "2020-01-01T00:00:00Z";
      commit(repo, { "a.txt": "a\n" }, "old");
      process.env.GIT_COMMITTER_DATE = "2026-01-01T00:00:00Z";
      commit(repo, { "b.txt": "b\n" }, "new");
    } finally {
      if (saved === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = saved;
    }
    expect(firstParentCommits(repo, null, "master").map((c) => c.title)).toEqual(["old", "new"]);
    expect(firstParentCommits(repo, null, "master", "2025-01-01").map((c) => c.title)).toEqual(["new"]);
  });

  it("keeps a tab inside a title", () => {
    const repo = makeRepo();
    const sha = commit(repo, { "a.txt": "a\n" }, "fix:\tthing");
    expect(firstParentCommits(repo, null, "master")).toEqual([{ sha, title: "fix:\tthing" }]);
  });

  it("is not confused by a file named like the branch", () => {
    const repo = makeRepo();
    const root = commit(repo, { "a.txt": "a\n" }, "first");
    commit(repo, { master: "x\n" }, "add master file");
    expect(firstParentCommits(repo, root, "master").map((c) => c.title)).toEqual(["add master file"]);
  });

  it("reads a file at a revision, or null when it is missing", () => {
    const repo = makeRepo();
    const first = commit(repo, { "src/a.txt": "one\n" }, "first");
    commit(repo, { "src/a.txt": "two\n" }, "second");
    expect(fileAt(repo, first, "src/a.txt")).toBe("one\n");
    expect(fileAt(repo, "HEAD", "src/a.txt")).toBe("two\n");
    expect(fileAt(repo, "HEAD", "src/missing.txt")).toBeNull();
  });

  it("returns null for a directory or an empty path", () => {
    const repo = makeRepo();
    commit(repo, { "src/a.txt": "one\n" }, "first");
    expect(fileAt(repo, "HEAD", "src")).toBeNull();
    expect(fileAt(repo, "HEAD", "")).toBeNull();
  });

  it("finds the top level of a repo, or null outside one", () => {
    const repo = makeRepo();
    commit(repo, { "src/a.txt": "a\n" }, "first");
    expect(toplevel(path.join(repo, "src"))).toBe(repo);
    const outside = tempDir("codebrain-plain-");
    fs.mkdirSync(path.join(outside, "x"));
    expect(toplevel(path.join(outside, "x"))).toBeNull();
  });

  it("finds the main repo from a linked worktree, wherever it lives", () => {
    const repo = makeRepo();
    commit(repo, { "src/a.txt": "a\n" }, "first");
    expect(repoRoots(path.join(repo, "src"))).toEqual({ top: repo, main: repo });
    const inside = path.join(repo, ".worktrees", "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", inside]);
    expect(repoRoots(path.join(inside, "src"))).toEqual({ top: inside, main: repo });
    const elsewhere = path.join(tempDir("codebrain-wt-"), "other");
    sh(repo, ["worktree", "add", "-q", "-b", "other", elsewhere]);
    expect(repoRoots(elsewhere)).toEqual({ top: elsewhere, main: repo });
    expect(repoRoots(tempDir("codebrain-plain-"))).toBeNull();
  });
});
