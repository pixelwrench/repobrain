import { describe, expect, it } from "vitest";
import { commitDiff, defaultBranch, firstParentCommits, isAncestor, mergeBase, revParse } from "../src/git.js";
import { commit, makeRepo, sh, tempDir } from "./helpers.js";

describe("git helpers", () => {
  it("uses the local branch when there is no remote", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    expect(defaultBranch(repo)).toBe("master");
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
});
