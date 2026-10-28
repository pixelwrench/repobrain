import { execFileSync } from "node:child_process";

export function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function tryGit(repo: string, args: string[]): string | null {
  try {
    return git(repo, args).trim();
  } catch {
    return null;
  }
}

/** origin's default branch when there is one, else the current local branch. */
export function defaultBranch(repo: string): string {
  const remoteHead = tryGit(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;
  for (const ref of ["origin/main", "origin/master"]) {
    if (tryGit(repo, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return tryGit(repo, ["symbolic-ref", "--short", "HEAD"]) ?? "HEAD";
}

export function fetchQuietly(repo: string): boolean {
  return tryGit(repo, ["fetch", "--quiet", "origin"]) !== null;
}

export function revParse(repo: string, rev: string): string {
  return git(repo, ["rev-parse", rev]).trim();
}

export function isAncestor(repo: string, a: string, b: string): boolean {
  return tryGit(repo, ["merge-base", "--is-ancestor", a, b]) !== null;
}

export function mergeBase(repo: string, a: string, b: string): string | null {
  return tryGit(repo, ["merge-base", a, b]);
}

export interface Commit {
  sha: string;
  title: string;
}

/** Commits on `to`'s first-parent line after `from` (or since a date when `from` is null), oldest first. */
export function firstParentCommits(repo: string, from: string | null, to: string, since?: string): Commit[] {
  const args = ["log", "--first-parent", "--reverse", "--format=%H%x09%s"];
  if (since) args.push(`--since=${since}`);
  args.push(from ? `${from}..${to}` : to);
  return git(repo, args)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("\t");
      return { sha: line.slice(0, i), title: line.slice(i + 1) };
    });
}

/** The change a commit made to its first parent, without excluded paths (glob pathspecs). */
export function commitDiff(repo: string, sha: string, excludes: string[]): string {
  const spec = ["--", ".", ...excludes.map((e) => `:(exclude,glob)${e}`)];
  const parent = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${sha}^1`]);
  return parent
    ? git(repo, ["diff", "--no-color", "--no-ext-diff", "-U3", parent, sha, ...spec])
    : git(repo, ["show", "--no-color", "--no-ext-diff", "--format=", sha, ...spec]);
}

export function fileAt(repo: string, rev: string, path: string): string | null {
  try {
    return git(repo, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

export function toplevel(dir: string): string | null {
  return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}
