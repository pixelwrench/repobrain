import fs from "node:fs";
import path from "node:path";
import { anchorStatusIn } from "./anchor.js";
import type { AnchorStatus, Card } from "./format.js";
import { ClaudeEnvError, ClaudeLimitError, ClaudeResultError, draftCards, ModelOutputError, runClaude, type RunClaude } from "./generate.js";
import { commitDiff, defaultBranch, fetchQuietly, fileAt, firstParentCommits, git, isAncestor, mergeBase, resolveCommit, toplevel } from "./git.js";
import { diffPaths, filterDiff } from "./guard.js";
import { acquireLock, appendLog, cardPath, listCards, loadConfig, readCard, readState, writeCard, writeState, type RepoState } from "./store.js";

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

function readIgnore(repoPath: string): string[] {
  try {
    return fs
      .readFileSync(path.join(repoPath, ".codebrain", "ignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
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
    const state: CaptureState = readState(key);
    const save = (sha: string) => {
      state.lastSha = sha;
      state.updatedAt = now().toISOString();
      writeState(key, state);
      lock.refresh();
    };
    /** Records a merge as fully handled (its cards written, or skipped) and saves past it. */
    const finish = (sha: string) => {
      if (state.processed) {
        state.processed = [...state.processed.filter((s) => s !== sha), sha].slice(-MAX_PROCESSED);
      }
      delete state.failures;
      save(sha);
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
    const excludes = [...DEFAULT_EXCLUDES, ...readIgnore(repo.path)];
    const commits = firstParentCommits(repo.path, from, head, from ? undefined : opts.since).slice(0, opts.maxMerges ?? DEFAULT_MAX_MERGES);

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
      const raw = commitDiff(repo.path, commit.sha, excludes, maxDiffBytes);
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
        // Retrying a merge that hit the budget would spend the same again for nothing.
        if (e instanceof ClaudeResultError && e.subtype === "error_max_budget_usd") {
          skip(`over budget: ${msg.slice(0, 200)}`);
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
        const count = state.failures?.sha === commit.sha ? state.failures.count + 1 : 1;
        if (count >= MAX_FAILURES) {
          skip(`failed ${count} times: ${msg}`);
          continue;
        }
        state.failures = { sha: commit.sha, count };
        writeState(key, state);
        appendLog(key, `${commit.sha} failed (attempt ${count} of ${MAX_FAILURES}): ${msg}`);
        return { ...report, status: "failed", error: msg };
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

    report.anchorsUpdated = updateAnchors(key, repo.path, head, lock.refresh);
    return report;
  } finally {
    lock.release();
  }
}

/** Re-checks kept cards' anchors at `head`; returns how many statuses changed. */
function updateAnchors(key: string, repoPath: string, head: string, refresh: () => void): number {
  refresh();
  const contents = new Map<string, string | null>();
  const ids = new Map<string, string | null>();
  let updated = 0;
  for (const listed of listCards(key)) {
    if (listed.status !== "kept" || listed.anchor.status === "orphaned") continue;
    try {
      const a = listed.anchor;
      const headId = memo(ids, `${head}:${a.path}`, () => objectId(repoPath, head, a.path));
      const anchoredId = memo(ids, `${a.commit}:${a.path}`, () => objectId(repoPath, a.commit, a.path));
      // Same blob as when anchored: the block is certainly still there.
      const status: AnchorStatus =
        headId !== null && headId === anchoredId
          ? "fresh"
          : anchorStatusIn(memo(contents, a.path, () => fileAt(repoPath, head, a.path)), a);
      if (status === a.status) continue;
      // Re-read just before writing, so a curate made meanwhile isn't reverted.
      const current: Card = readCard(key, listed.id);
      const same = current.anchor.commit === a.commit && current.anchor.path === a.path && current.anchor.fingerprint === a.fingerprint;
      if (current.status !== "kept" || !same || current.anchor.status === status) continue;
      writeCard(key, { ...current, anchor: { ...current.anchor, status } });
      updated++;
    } catch (e) {
      appendLog(key, `anchor check for ${listed.id} failed: ${message(e)}`);
    }
  }
  return updated;
}
