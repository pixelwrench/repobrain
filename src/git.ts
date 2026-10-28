import { execFileSync } from "node:child_process";

export interface GitOptions {
  /** Kill git (SIGKILL) after this many milliseconds. */
  timeoutMs?: number;
  maxBuffer?: number;
}

export function git(repo: string, args: string[], options: GitOptions = {}): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" },
  });
}

function tryGit(repo: string, args: string[], options?: GitOptions): string | null {
  try {
    return git(repo, args, options).trim();
  } catch {
    return null;
  }
}

function isCommit(repo: string, rev: string): boolean {
  return tryGit(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) !== null;
}

/**
 * The branch capture follows: origin's default branch, else origin/main or origin/master,
 * else a local main, master or init.defaultBranch, else the current branch (which may have
 * no commits yet). Null for a detached HEAD when none of those exist.
 */
export function defaultBranch(repo: string): string | null {
  const remoteHead = tryGit(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead && isCommit(repo, remoteHead)) return remoteHead;
  for (const ref of ["origin/main", "origin/master"]) {
    if (isCommit(repo, ref)) return ref;
  }
  const configured = tryGit(repo, ["config", "--get", "init.defaultBranch"]);
  for (const name of ["main", "master", ...(configured ? [configured] : [])]) {
    if (isCommit(repo, `refs/heads/${name}`)) return name;
  }
  return tryGit(repo, ["symbolic-ref", "--short", "HEAD"]) || null;
}

/** The commit `rev` names, or null when it names none (an unborn branch, say). */
export function resolveCommit(repo: string, rev: string): string | null {
  return tryGit(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]) || null;
}

export function fetchQuietly(repo: string): boolean {
  const args = ["fetch", "--quiet", "--no-recurse-submodules", "--no-auto-gc", "origin"];
  return tryGit(repo, args, { timeoutMs: 30_000 }) !== null;
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
  const args = ["log", "--first-parent", "--reverse", "--no-show-signature", "--format=%H%x09%s"];
  if (since) args.push(`--since=${since}`);
  args.push(from ? `${from}..${to}` : to, "--");
  return git(repo, args)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("\t");
      return { sha: line.slice(0, i), title: line.slice(i + 1) };
    });
}

const DIFF_FORMAT = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
  "-U3",
];

/**
 * The commit's parents as recorded in the commit object itself. Unlike rev-list, this
 * still shows the parent of a shallow clone's boundary commit, which git grafts as a root.
 */
function rawParents(repo: string, sha: string): string[] {
  const header = git(repo, ["cat-file", "commit", sha]).split("\n\n")[0];
  return header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length).trim());
}

function isTooLarge(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "ENOBUFS" || /maxBuffer/i.test(e.message ?? "");
}

/**
 * The change a commit made to its first parent, without excluded paths (glob pathspecs).
 * Null means skip it: its first parent is missing (a shallow boundary) or the diff exceeds maxBytes.
 */
export function commitDiff(repo: string, sha: string, excludes: string[], maxBytes = 60_000): string | null {
  const spec = ["--", ".", ...excludes.map((e) => `:(exclude,glob)${e}`)];
  const parents = rawParents(repo, sha);
  let base: string;
  if (parents.length === 0) {
    base = git(repo, ["hash-object", "-t", "tree", "/dev/null"]).trim();
  } else {
    if (tryGit(repo, ["cat-file", "-e", `${parents[0]}^{commit}`]) === null) return null;
    base = parents[0];
  }
  try {
    return git(repo, ["diff", ...DIFF_FORMAT, base, sha, ...spec], { maxBuffer: maxBytes + 1 });
  } catch (err) {
    if (isTooLarge(err)) return null;
    throw err;
  }
}

/** A file's content at `rev`, or null when the path is missing, empty or not a file (a directory, say). */
export function fileAt(repo: string, rev: string, path: string): string | null {
  if (path === "") return null;
  try {
    return git(repo, ["cat-file", "blob", `${rev}:${path}`]);
  } catch {
    return null;
  }
}

export function toplevel(dir: string): string | null {
  return tryGit(dir, ["rev-parse", "--show-toplevel"]);
}
