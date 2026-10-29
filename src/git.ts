import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

/**
 * `git fetch origin`, never prompting. ssh runs in batch mode (no password or host-key prompts),
 * unless the user set their own ssh command (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand), which is kept as is.
 */
export function fetchQuietly(repo: string): boolean {
  const ownSsh = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || tryGit(repo, ["config", "--get", "core.sshCommand"]);
  const batch = ownSsh ? [] : ["-c", "core.sshCommand=ssh -o BatchMode=yes"];
  const args = [...batch, "fetch", "--quiet", "--no-recurse-submodules", "--no-auto-gc", "origin"];
  return tryGit(repo, args, { timeoutMs: 30_000 }) !== null;
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

/** Every path except the excluded ones (glob pathspecs), so diffs and file lists leave out the same paths. */
const excludeSpec = (excludes: string[]): string[] => ["--", ".", ...excludes.map((e) => `:(exclude,glob)${e}`)];

const emptyTree = (repo: string): string => git(repo, ["hash-object", "-t", "tree", "/dev/null"]).trim();

/**
 * The change a commit made to its first parent, without excluded paths (glob pathspecs).
 * Null means skip it: its first parent is missing (a shallow boundary) or the diff exceeds maxBytes.
 */
export function commitDiff(repo: string, sha: string, excludes: string[], maxBytes = 60_000): string | null {
  const spec = excludeSpec(excludes);
  const parents = rawParents(repo, sha);
  let base: string;
  if (parents.length === 0) {
    base = emptyTree(repo);
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

export interface TreeFile {
  path: string;
  lines: number;
}

/**
 * The text files in a commit's tree with their line counts, in git's path order, without excluded
 * paths (the same glob pathspecs as commitDiff). Binary files are left out. Diffing the tree against
 * the empty tree gives both the exclusions and the line counts from git itself.
 */
export function treeFiles(repo: string, sha: string, excludes: string[]): TreeFile[] {
  const out = git(repo, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", emptyTree(repo), sha, ...excludeSpec(excludes)], {
    timeoutMs: 120_000,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      // "added<TAB>deleted<TAB>path"; a binary file has "-" for both counts.
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      return m && m[1] !== "-" ? [{ path: m[3]!, lines: Number(m[1]) }] : [];
    });
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

export function toplevel(dir: string, options?: GitOptions): string | null {
  return tryGit(dir, ["rev-parse", "--show-toplevel"], options);
}

/**
 * The working tree `dir` is in (`top`) and the repository's main working tree (`main`), in one git call.
 * They differ in a linked worktree. `main` falls back to `top` when the common dir isn't `<main>/.git`
 * (a submodule, say). Null outside a working tree.
 */
export function repoRoots(dir: string, options?: GitOptions): { top: string; main: string } | null {
  const out = tryGit(dir, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], options);
  const [top, common] = out?.split("\n") ?? [];
  if (!top) return null;
  if (!common || path.basename(common) !== ".git") return { top, main: top };
  let main = path.dirname(common);
  try {
    main = fs.realpathSync(main);
  } catch {
    return { top, main: top };
  }
  return { top, main };
}
