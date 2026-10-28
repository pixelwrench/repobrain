import fs from "node:fs";
import path from "node:path";
import { locateAnchor, type AnchorMatch } from "./anchor.js";
import type { Anchor, Card } from "./format.js";
import { ClaudeEnvError, ClaudeLimitError, ClaudeResultError, draftCards, ModelOutputError, runClaude, type RunClaude } from "./generate.js";
import { commitDiff, defaultBranch, fetchQuietly, fileAt, firstParentCommits, git, isAncestor, mergeBase, resolveCommit, toplevel } from "./git.js";
import { diffPaths, filterDiff } from "./guard.js";
import { acquireLock, appendLog, cardPath, listCards, loadConfig, readCard, readState, writeCard, writeState, type RepoConfig, type RepoState } from "./store.js";

/** Glob pathspecs never sent to the model. `.codebrain/ignore` in the repo adds more, one per line. */
export const DEFAULT_EXCLUDES = [
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/*.lock", "**/*.min.js", "**/*.map",
  "**/*.snap", "**/dist/**", "**/build/**", "**/vendor/**", "**/node_modules/**", "**/.env*", "**/*.pem", "**/*.key",
];

const DEFAULT_MAX_MERGES = 5;
const DEFAULT_MAX_DIFF_BYTES = 60_000;
/** A merge whose drafting fails this many times in a row is skipped. */
const MAX_FAILURES = 3;
/** How many recently processed merges the state file remembers. */
const MAX_PROCESSED = 500;

export interface CaptureOptions {
  /** Most merges drafted per run (default 5); the rest wait for the next run. */
  maxMerges?: number;
  /** On a first run, draft merges since this date (git --since syntax) instead of only initialising. */
  since?: string;
  /** A merge whose raw diff exceeds this many bytes is skipped (default 60,000). */
  maxDiffBytes?: number;
  /** Fetch origin first (default true). */
  fetch?: boolean;
  run?: RunClaude;
  now?: () => Date;
}

/** The repo state as capture keeps it; an alias kept for callers that imported it from here. */
export type CaptureState = RepoState;

export interface CaptureReport {
  status: "locked" | "initialized" | "done" | "failed";
  processed: number;
  cardsWritten: number;
  skipped: number;
  anchorsUpdated: number;
  error?: string;
}

/**
 * `.codebrain/ignore` as git pathspec globs. A leading `/` (gitignore's "from the root") is
 * stripped, since pathspecs are already relative to the root. Lines git would reject or read as
 * something else (`!` negation, `:` pathspec magic) are dropped, each reported through `drop`.
 */
function readIgnore(repoPath: string, drop: (line: string) => void): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoPath, ".codebrain", "ignore"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return [];
    if (line.startsWith("!") || line.startsWith(":")) {
      drop(line);
      return [];
    }
    const glob = line.replace(/^\/+/, "");
    return glob ? [glob] : [];
  });
}

/** The object id at `rev:path`, or null when the path is missing there. */
function objectId(repo: string, rev: string, p: string): string | null {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", `${rev}:${p}`]).trim() || null;
  } catch {
    return null;
  }
}

function memo<V>(cache: Map<string, V>, k: string, load: () => V): V {
  if (!cache.has(k)) cache.set(k, load());
  return cache.get(k)!;
}

/**
 * Whether writing this drafted card is safe. A card file that exists and isn't a draft
 * (or can't be read) holds the user's curation, which a retry must never replace.
 */
function mayWrite(key: string, id: string): boolean {
  if (!fs.existsSync(cardPath(key, id))) return true;
  try {
    return readCard(key, id).status === "draft";
  } catch {
    return false;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runCapture(key: string, opts: CaptureOptions = {}): Promise<CaptureReport> {
  try {
    return await capture(key, opts);
  } catch (e) {
    // Capture runs detached, so capture.log is the only place this failure can show up.
    try {
      appendLog(key, `capture failed: ${message(e)}`);
    } catch {
      // An unusable key or an unwritable home: nothing more to do than rethrow.
    }
    throw e;
  }
}

/** Saves an unexpected failure as state.lastError, for week and stats. Best effort: state.json may be the problem. */
function recordError(key: string, msg: string, at: Date): void {
  try {
    const state = readState(key);
    state.lastError = { at: at.toISOString(), message: msg.slice(0, 500) };
    writeState(key, state);
  } catch {
    // Already logged; nothing more to do.
  }
}

async function capture(key: string, opts: CaptureOptions): Promise<CaptureReport> {
  const repo = loadConfig().repos[key];
  if (!repo) throw new Error(`unknown repo ${key}; run codebrain connect first`);
  const report: CaptureReport = { status: "done", processed: 0, cardsWritten: 0, skipped: 0, anchorsUpdated: 0 };
  const lock = acquireLock(key);
  if (!lock) return { ...report, status: "locked" };
  const now = opts.now ?? (() => new Date());
  const maxDiffBytes = opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  try {
    if (toplevel(repo.path) === null) {
      appendLog(key, `repo path ${repo.path} is gone or not a git repo; nothing to capture`);
      return report;
    }
    if (opts.fetch ?? true) fetchQuietly(repo.path);
    const branch = defaultBranch(repo.path);
    if (branch === null) {
      appendLog(key, "no default branch found (detached HEAD and no main or master); nothing to capture");
      return report;
    }
    const head = resolveCommit(repo.path, branch);
    if (head === null) {
      appendLog(key, `no commits on ${branch} yet; nothing to capture`);
      return report;
    }
    const state: RepoState = readState(key);
    const result = await captureMerges(key, repo, state, branch, head, report, opts, now, maxDiffBytes, lock.refresh);
    // Every path that got this far checks anchors, including a run that stopped early on a failure.
    result.anchorsUpdated = updateAnchors(key, repo.path, head, lock.refresh);
    if (result.status !== "failed" && state.lastError) {
      delete state.lastError;
      writeState(key, state);
    }
    return result;
  } catch (e) {
    recordError(key, message(e), now());
    throw e;
  } finally {
    lock.release();
  }
}

/** Drafts cards for the merges after state.lastSha, saving progress as it goes. */
async function captureMerges(
  key: string,
  repo: RepoConfig,
  state: RepoState,
  branch: string,
  head: string,
  report: CaptureReport,
  opts: CaptureOptions,
  now: () => Date,
  maxDiffBytes: number,
  refresh: () => void,
): Promise<CaptureReport> {
  const save = (sha: string) => {
    state.lastSha = sha;
    state.updatedAt = now().toISOString();
    writeState(key, state);
    refresh();
  };
  /** Records a merge as fully handled (its cards written, or skipped) and saves past it. */
  const finish = (sha: string) => {
    if (state.processed) {
      state.processed = [...state.processed.filter((s) => s !== sha), sha].slice(-MAX_PROCESSED);
    }
    delete state.failures;
    save(sha);
  };
  const fail = (msg: string): CaptureReport => {
    state.lastError = { at: now().toISOString(), message: msg.slice(0, 500) };
    writeState(key, state);
    return { ...report, status: "failed", error: msg };
  };

  if (!state.lastSha && !opts.since) {
    state.processed = [];
    save(head);
    return { ...report, status: "initialized" };
  }
  let from: string | null = null;
  if (state.lastSha) {
    // After a force-push or rebase, restart from the common ancestor.
    from = isAncestor(repo.path, state.lastSha, head) ? state.lastSha : mergeBase(repo.path, state.lastSha, head);
    if (from === null) {
      // The saved commit is gone (force-push plus gc) or unrelated: drafting from the root would flood the user.
      appendLog(key, `saved commit ${state.lastSha} shares no history with ${branch}; re-initialising at ${head}`);
      delete state.failures;
      state.processed = [];
      save(head);
      return { ...report, status: "initialized" };
    }
  }
  // Old state files have no processed list: fall back to merges that have card files.
  const done = new Set(state.processed ?? listCards(key).map((c) => c.merge));
  state.processed ??= [];
  const excludes = [...DEFAULT_EXCLUDES, ...readIgnore(repo.path, (line) => appendLog(key, `ignore line dropped: ${JSON.stringify(line)} (negation and pathspec magic aren't supported)`))];
  let commits;
  try {
    commits = firstParentCommits(repo.path, from, head, from ? undefined : opts.since).slice(0, opts.maxMerges ?? DEFAULT_MAX_MERGES);
  } catch (e) {
    appendLog(key, `listing merges failed: ${message(e)}`);
    return fail(`git: ${message(e)}`);
  }

  for (const commit of commits) {
    if (done.has(commit.sha)) {
      finish(commit.sha);
      continue;
    }
    const skip = (why: string) => {
      report.skipped++;
      appendLog(key, `${commit.sha} skipped (${why})`);
      finish(commit.sha);
    };
    /** A failure caused by this merge: retried next run, and skipped on the third in a row. */
    const strike = (msg: string): CaptureReport | null => {
      const count = state.failures?.sha === commit.sha ? state.failures.count + 1 : 1;
      if (count >= MAX_FAILURES) {
        skip(`failed ${count} times: ${msg}`);
        return null;
      }
      state.failures = { sha: commit.sha, count };
      writeState(key, state);
      appendLog(key, `${commit.sha} failed (attempt ${count} of ${MAX_FAILURES}): ${msg}`);
      return { ...report, status: "failed", error: msg };
    };
    let raw: string | null;
    try {
      raw = commitDiff(repo.path, commit.sha, excludes, maxDiffBytes);
    } catch (e) {
      const msg = `git: ${message(e)}`;
      state.lastError = { at: now().toISOString(), message: msg.slice(0, 500) };
      const stopped = strike(msg);
      if (stopped) return stopped;
      continue;
    }
    if (raw === null) {
      skip(`shallow boundary or diff over ${maxDiffBytes} bytes`);
      continue;
    }
    const { diff, droppedHunks, droppedFiles } = filterDiff(raw);
    if (droppedHunks || droppedFiles) appendLog(key, `${commit.sha} secret filter dropped ${droppedHunks} hunks, ${droppedFiles} files`);
    if (diff.trim() === "") {
      skip("nothing to send");
      continue;
    }
    let drafted;
    try {
      drafted = await draftCards(
        {
          repoPath: repo.path, repoName: path.basename(repo.path), merge: commit.sha, title: commit.title,
          diff, files: diffPaths(diff), areaDepth: repo.areaDepth, now: now(),
        },
        opts.run ?? runClaude,
      );
    } catch (e) {
      const msg = message(e);
      if (e instanceof ModelOutputError) {
        delete state.unavailable; // claude answered, just not usefully
        skip(msg);
        continue;
      }
      if (!(e instanceof ClaudeResultError || e instanceof ClaudeLimitError)) {
        // claude missing, logged out, offline or similar: not this merge's fault, so no strike.
        if (e instanceof ClaudeEnvError) {
          state.unavailable = { since: state.unavailable?.since ?? now().toISOString(), message: msg.slice(0, 500) };
          writeState(key, state);
        }
        appendLog(key, `${commit.sha} not drafted, claude unavailable: ${msg}`);
        return { ...report, status: "failed", error: msg };
      }
      // claude ran and failed this merge, so it isn't unavailable.
      delete state.unavailable;
      // Retrying a merge that hit the budget would spend the same again for nothing.
      if (e instanceof ClaudeResultError && e.subtype === "error_max_budget_usd") {
        skip(`over budget: ${msg.slice(0, 200)}`);
        continue;
      }
      const stopped = strike(msg);
      if (stopped) return stopped;
      continue;
    }
    delete state.unavailable;
    const { cards, rejected } = drafted;
    let written = 0;
    for (const card of cards) {
      if (!mayWrite(key, card.id)) {
        appendLog(key, `${commit.sha} not overwriting ${card.id}: it exists and isn't a draft`);
        continue;
      }
      writeCard(key, card);
      written++;
    }
    report.processed++;
    report.cardsWritten += written;
    appendLog(key, `${commit.sha} ${written} cards, ${rejected.length} rejected${rejected.length ? `: ${rejected.map((r) => r.reason).join(" | ")}` : ""}`);
    // Only now, with every card file written, does the merge count as processed.
    finish(commit.sha);
  }
  if (commits.length === 0 && state.lastSha !== head) save(head);
  return report;
}

/**
 * Re-checks kept cards' anchors at `head`, orphaned ones included since a file can come back.
 * A block found at other lines moves the card's range there (re-anchored at `head`).
 * Returns how many cards changed.
 */
function updateAnchors(key: string, repoPath: string, head: string, refresh: () => void): number {
  refresh();
  const contents = new Map<string, string | null>();
  const ids = new Map<string, string | null>();
  let updated = 0;
  for (const listed of listCards(key)) {
    if (listed.status !== "kept") continue;
    try {
      const a = listed.anchor;
      const headId = memo(ids, `${head}:${a.path}`, () => objectId(repoPath, head, a.path));
      const anchoredId = memo(ids, `${a.commit}:${a.path}`, () => objectId(repoPath, a.commit, a.path));
      // Same blob as when anchored: the block is certainly still there, at the same lines.
      const match: AnchorMatch =
        headId !== null && headId === anchoredId
          ? { status: "fresh", startLine: a.startLine, endLine: a.endLine }
          : locateAnchor(memo(contents, a.path, () => fileAt(repoPath, head, a.path)), a);
      const next: Anchor =
        match.status === "fresh" && (match.startLine !== a.startLine || match.endLine !== a.endLine)
          ? { ...a, commit: head, startLine: match.startLine, endLine: match.endLine, status: "fresh" }
          : { ...a, status: match.status };
      if (next.status === a.status && next.startLine === a.startLine && next.endLine === a.endLine) continue;
      // Re-read just before writing, so a curate made meanwhile isn't reverted.
      const current: Card = readCard(key, listed.id);
      const same = current.anchor.commit === a.commit && current.anchor.path === a.path && current.anchor.fingerprint === a.fingerprint;
      if (current.status !== "kept" || !same) continue;
      writeCard(key, { ...current, anchor: { ...current.anchor, commit: next.commit, startLine: next.startLine, endLine: next.endLine, status: next.status } });
      updated++;
    } catch (e) {
      appendLog(key, `anchor check for ${listed.id} failed: ${message(e)}`);
    }
  }
  return updated;
}
