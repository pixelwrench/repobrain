import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCapture, type CaptureOptions, type CaptureState } from "../src/capture.js";
import { ClaudeEnvError, ClaudeLimitError, ClaudeResultError, type RunClaude } from "../src/generate.js";
import { acquireLock, cardPath, connectRepo, listCards, readCard, readState, repoDir, writeCard, writeState } from "../src/store.js";
import { commit, makeRepo, sh, useTempHome } from "./helpers.js";

// Pass-through mocks with hooks, so tests can count calls and act at precise moments.
const hooks = vi.hoisted(() => ({
  beforeStatus: null as null | ((cardPath: string) => void),
  statusChecks: 0,
  fileReads: [] as string[],
  refreshes: 0,
  releases: 0,
}));

vi.mock("../src/anchor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/anchor.js")>();
  return {
    ...real,
    anchorStatusIn: (content: string | null, anchor: import("../src/format.js").Anchor) => {
      hooks.statusChecks++;
      hooks.beforeStatus?.(anchor.path);
      return real.anchorStatusIn(content, anchor);
    },
  };
});

vi.mock("../src/git.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...real,
    fileAt: (repo: string, rev: string, p: string) => {
      hooks.fileReads.push(p);
      return real.fileAt(repo, rev, p);
    },
  };
});

vi.mock("../src/store.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/store.js")>();
  return {
    ...real,
    acquireLock: (key: string, staleMs?: number) => {
      const lock = real.acquireLock(key, staleMs);
      if (!lock) return null;
      return {
        release: () => {
          hooks.releases++;
          lock.release();
        },
        refresh: () => {
          hooks.refreshes++;
          lock.refresh();
        },
      };
    },
  };
});

const FILE = ["export function applyReferral(code: string) {", "  const ref = lookup(code);", "  if (!ref) return null;", "  return discount(ref);", "}", ""].join("\n");

const cardFor = (p: string, over: Record<string, unknown> = {}) => ({
  kind: "flashcard", front: `What lives in ${p}?`, back: "The referral lookup.", path: p, startLine: 1, endLine: 5, symbol: null, ...over,
});
const fake = (p = "src/ref.ts"): RunClaude => async () => JSON.stringify([cardFor(p)]);
const fakeTwo = (p = "src/ref.ts"): RunClaude => async () =>
  JSON.stringify([cardFor(p), cardFor(p, { front: `Why does ${p} return null?`, startLine: 2, endLine: 4 })]);
const empty: RunClaude = async () => "[]";
const fakeThree = (p = "src/ref.ts"): RunClaude => async () =>
  JSON.stringify([
    cardFor(p),
    cardFor(p, { front: `Why does ${p} return null?`, startLine: 2, endLine: 4 }),
    cardFor(p, { front: `What does ${p} call to apply a discount?`, startLine: 4, endLine: 4 }),
  ]);
const failing = (make: () => Error = () => new ClaudeLimitError("claude timed out")): RunClaude => async () => {
  throw make();
};
const opts = (run: RunClaude, over: CaptureOptions = {}): CaptureOptions => ({
  fetch: false, run, now: () => new Date("2026-11-02T09:00:00Z"), ...over,
});

describe("runCapture", () => {
  let repo: string;
  let key: string;
  const log = () => fs.readFileSync(path.join(repoDir(key), "capture.log"), "utf8");
  const lockFile = () => path.join(repoDir(key), "capture.lock");

  beforeEach(() => {
    useTempHome();
    repo = makeRepo();
    commit(repo, { "README.md": "demo\n" }, "first");
    key = connectRepo(repo);
    hooks.beforeStatus = null;
    hooks.statusChecks = 0;
    hooks.fileReads = [];
    hooks.refreshes = 0;
    hooks.releases = 0;
  });

  /** Captures one merge of src/ref.ts and keeps its cards. */
  async function keptCards(run: RunClaude = fake()) {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(run));
    for (const c of listCards(key)) writeCard(key, { ...c, status: "kept" });
    return listCards(key);
  }

  it("initialises on the first run without drafting old history", async () => {
    const report = await runCapture(key, opts(fake()));
    expect(report.status).toBe("initialized");
    expect(readState(key).lastSha).toBe(sh(repo, ["rev-parse", "HEAD"]));
    expect(listCards(key)).toEqual([]);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("drafts cards for new merges and advances", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const report = await runCapture(key, opts(fake()));
    expect(report).toMatchObject({ status: "done", processed: 1, cardsWritten: 1 });
    expect(listCards(key)[0]).toMatchObject({ merge: sha, mergeTitle: "feat: referral codes", status: "draft" });
    expect(readState(key).lastSha).toBe(sha);
    expect((await runCapture(key, opts(fake()))).processed).toBe(0);
  });

  it("sends the model the title and only the filtered diff", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE, "package-lock.json": "{}\n" }, "feat: referral codes");
    let stdin = "";
    await runCapture(key, opts(async (_p, s) => ((stdin = s), JSON.stringify([cardFor("src/ref.ts")]))));
    expect(stdin).toMatch(/^Title: feat: referral codes\n/);
    expect(stdin).toContain("src/ref.ts");
    expect(stdin).not.toContain("package-lock.json");
  });

  it("processes recent history with --since on the first run", async () => {
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const report = await runCapture(key, opts(fake(), { since: "1 year ago" }));
    expect(report.processed).toBeGreaterThanOrEqual(1);
    expect(report.cardsWritten).toBe(1);
  });

  it("caps the merges handled per run", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/a.ts": FILE }, "a");
    const second = commit(repo, { "src/b.ts": FILE }, "b");
    commit(repo, { "src/c.ts": FILE }, "c");
    expect((await runCapture(key, opts(empty, { maxMerges: 2 }))).processed).toBe(2);
    expect(readState(key).lastSha).toBe(second);
  });

  it("does not advance past a failed run, and retries next time", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const before = readState(key).lastSha;
    expect((await runCapture(key, opts(failing()))).status).toBe("failed");
    expect(readState(key).lastSha).toBe(before);
    expect(fs.existsSync(lockFile())).toBe(false);
    expect((await runCapture(key, opts(fake()))).cardsWritten).toBe(1);
  });

  it("gives up on a merge after it fails three times, and advances", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const before = readState(key).lastSha;
    expect((await runCapture(key, opts(failing()))).status).toBe("failed");
    expect(readState(key)).toMatchObject({ lastSha: before, failures: { sha, count: 1 } });
    expect((await runCapture(key, opts(failing()))).status).toBe("failed");
    expect(readState(key).failures).toEqual({ sha, count: 2 });
    expect(await runCapture(key, opts(failing()))).toMatchObject({ status: "done", skipped: 1 });
    expect(readState(key).lastSha).toBe(sha);
    expect(readState(key).failures).toBeUndefined();
    expect(log()).toContain(`${sha} skipped (failed 3 times: claude timed out)`);
  });

  it("resets the failure count after a success, and counts a new merge from one", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(failing()));
    await runCapture(key, opts(failing()));
    expect((await runCapture(key, opts(fake()))).cardsWritten).toBe(1);
    expect(readState(key).failures).toBeUndefined();
    const next = commit(repo, { "src/other.ts": FILE }, "feat: other");
    expect((await runCapture(key, opts(failing()))).status).toBe("failed");
    expect(readState(key).failures).toEqual({ sha: next, count: 1 });
  });

  it("skips a merge at once when claude ran out of budget", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const run = failing(() => new ClaudeResultError("error_max_budget_usd", "claude returned an error (error_max_budget_usd)"));
    expect(await runCapture(key, opts(run))).toMatchObject({ status: "done", skipped: 1 });
    expect(readState(key).lastSha).toBe(sha);
    expect(log()).toContain(`${sha} skipped (over budget`);
  });

  it("counts other claude result errors as strikes", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const run = failing(() => new ClaudeResultError("error_during_execution", "claude returned an error (error_during_execution)"));
    expect((await runCapture(key, opts(run))).status).toBe("failed");
    expect(readState(key).failures).toEqual({ sha, count: 1 });
  });

  it("never strikes a merge when claude itself is unavailable", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const before = readState(key);
    const run = failing(() => new ClaudeEnvError("spawn claude ENOENT"));
    for (let i = 0; i < 4; i++) expect((await runCapture(key, opts(run))).status).toBe("failed");
    expect(readState(key).lastSha).toBe(before.lastSha);
    expect(readState(key).failures).toBeUndefined();
    expect(log()).toContain("claude unavailable: spawn claude ENOENT");
    expect(listCards(key)).toEqual([]);
  });

  it("never strikes a merge for an API error such as a bad key, and records claude as unavailable", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const before = readState(key);
    const run = failing(() => new ClaudeEnvError("claude failed (API error 401): Invalid API key · Fix external API key"));
    for (let i = 0; i < 4; i++) expect((await runCapture(key, opts(run))).status).toBe("failed");
    const after: CaptureState = readState(key);
    expect(after.lastSha).toBe(before.lastSha);
    expect(after.failures).toBeUndefined();
    expect(after.unavailable).toEqual({ since: "2026-11-02T09:00:00.000Z", message: expect.stringContaining("Invalid API key") });
    expect((await runCapture(key, opts(fake()))).cardsWritten).toBe(1);
    expect((readState(key) as CaptureState).unavailable).toBeUndefined();
  });

  it("clears the unavailable record after any successful claude call, even a skipped merge", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(failing(() => new ClaudeEnvError("offline"))));
    expect((readState(key) as CaptureState).unavailable?.message).toBe("offline");
    await runCapture(key, opts(async () => "no idea"));
    expect((readState(key) as CaptureState).unavailable).toBeUndefined();
  });

  it("clears the unavailable record when claude ran but failed the merge (a strike)", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(failing(() => new ClaudeEnvError("offline"))));
    expect((readState(key) as CaptureState).unavailable?.message).toBe("offline");
    expect((await runCapture(key, opts(failing()))).status).toBe("failed");
    const after: CaptureState = readState(key);
    expect(after.failures).toEqual({ sha, count: 1 });
    expect(after.unavailable).toBeUndefined();
  });

  it("clears the unavailable record when a merge is skipped for running over budget", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(failing(() => new ClaudeEnvError("offline"))));
    const run = failing(() => new ClaudeResultError("error_max_budget_usd", "claude returned an error (error_max_budget_usd)"));
    expect(await runCapture(key, opts(run))).toMatchObject({ status: "done", skipped: 1 });
    expect((readState(key) as CaptureState).unavailable).toBeUndefined();
  });

  it("does nothing, quietly, when the repo path is gone", async () => {
    await runCapture(key, opts(fake()));
    const before = readState(key);
    fs.rmSync(repo, { recursive: true, force: true });
    expect(await runCapture(key, opts(fake()))).toMatchObject({ status: "done", processed: 0 });
    expect(readState(key)).toEqual(before);
    expect(log()).toContain(`repo path ${repo} is gone or not a git repo`);
  });

  it("re-initialises when the saved commit shares no history with the branch", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const head = sh(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repoDir(key), "state.json"), JSON.stringify({ lastSha: "deadbeef".repeat(5), updatedAt: null }));
    let called = false;
    const report = await runCapture(key, opts(async () => ((called = true), "[]")));
    expect(report.status).toBe("initialized");
    expect(called).toBe(false);
    expect(readState(key).lastSha).toBe(head);
    expect(log()).toContain(`${"deadbeef".repeat(5)} shares no history`);
  });

  it("captures the default branch, not the checked-out feature branch", async () => {
    await runCapture(key, opts(fake()));
    sh(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, { "src/wip.ts": FILE }, "wip");
    expect((await runCapture(key, opts(fake("src/wip.ts")))).processed).toBe(0);
    sh(repo, ["checkout", "-q", "master"]);
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    sh(repo, ["checkout", "-q", "feature"]);
    expect(await runCapture(key, opts(fake()))).toMatchObject({ processed: 1, cardsWritten: 1 });
    expect(readState(key).lastSha).toBe(sha);
  });

  it("does nothing, quietly, on a detached HEAD with no default branch", async () => {
    sh(repo, ["branch", "-m", "trunk"]);
    sh(repo, ["checkout", "-q", "--detach"]);
    expect(await runCapture(key, opts(fake()))).toMatchObject({ status: "done", processed: 0 });
    expect(readState(key).lastSha).toBeNull();
    expect(log()).toContain("no default branch found");
  });

  it("does nothing, quietly, in a repo with no commits", async () => {
    const bare = makeRepo();
    const k = connectRepo(bare);
    expect(await runCapture(k, opts(fake()))).toMatchObject({ status: "done", processed: 0 });
    expect(fs.readFileSync(path.join(repoDir(k), "capture.log"), "utf8")).toContain("no commits");
  });

  it("records processed merges and re-drafts a merge interrupted mid-write", async () => {
    await runCapture(key, opts(fake()));
    const init = readState(key).lastSha;
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fakeThree()));
    expect(readState(key).processed).toEqual([sha]);
    const [first, second, third] = listCards(key);
    // Simulate a crash after the first card file was written.
    fs.rmSync(cardPath(key, second.id));
    fs.rmSync(cardPath(key, third.id));
    writeCard(key, { ...first, mergeTitle: "stale" });
    fs.writeFileSync(path.join(repoDir(key), "state.json"), JSON.stringify({ lastSha: init, updatedAt: null, processed: [] }));
    expect((await runCapture(key, opts(fakeThree()))).cardsWritten).toBe(3);
    expect(listCards(key)).toHaveLength(3);
    expect(readCard(key, first.id).mergeTitle).toBe("feat: referral codes");
    expect(readState(key).processed).toEqual([sha]);

    // The same crash with the first card already kept: it survives the re-draft.
    fs.rmSync(cardPath(key, second.id));
    fs.rmSync(cardPath(key, third.id));
    writeCard(key, { ...first, status: "kept", mergeTitle: "curated" });
    fs.writeFileSync(path.join(repoDir(key), "state.json"), JSON.stringify({ lastSha: init, updatedAt: null, processed: [] }));
    expect((await runCapture(key, opts(fakeThree()))).cardsWritten).toBe(2);
    expect(readCard(key, first.id)).toMatchObject({ status: "kept", mergeTitle: "curated" });
  });

  it("falls back to card files to tell done merges apart in an old state file", async () => {
    await runCapture(key, opts(fake()));
    const init = readState(key).lastSha;
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fake()));
    fs.writeFileSync(path.join(repoDir(key), "state.json"), JSON.stringify({ lastSha: init, updatedAt: null }));
    let called = false;
    await runCapture(key, opts(async () => ((called = true), "[]")));
    expect(called).toBe(false);
  });

  it("caps the processed list at the last 500 merges", async () => {
    await runCapture(key, opts(fake()));
    const old = Array.from({ length: 500 }, (_, i) => i.toString(16).padStart(40, "0"));
    writeState(key, { ...readState(key), processed: old });
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fake()));
    const processed = readState(key).processed!;
    expect(processed).toHaveLength(500);
    expect(processed[0]).toBe(old[1]);
    expect(processed.at(-1)).toBe(sha);
  });

  it("never overwrites a card the user has curated, even on a retry", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fakeTwo()));
    const [first, second] = listCards(key);
    // Curated, but recorded under another merge, so the merge is retried.
    writeCard(key, { ...first, status: "kept", merge: "f".repeat(40) });
    fs.writeFileSync(cardPath(key, second.id), "nonsense");
    fs.writeFileSync(
      path.join(repoDir(key), "state.json"),
      JSON.stringify({ lastSha: sh(repo, ["rev-parse", "HEAD~1"]), updatedAt: null }),
    );
    const report = await runCapture(key, opts(fakeTwo()));
    expect(report).toMatchObject({ status: "done", processed: 1, cardsWritten: 0 });
    expect(readCard(key, first.id)).toMatchObject({ status: "kept", merge: "f".repeat(40) });
    expect(fs.readFileSync(cardPath(key, second.id), "utf8")).toBe("nonsense");
    expect(log()).toContain(`not overwriting ${first.id}`);
    expect(log()).toContain(`not overwriting ${second.id}`);
  });

  it("overwrites an existing draft on a retry", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fake()));
    const [card] = listCards(key);
    writeCard(key, { ...card, merge: "f".repeat(40) });
    fs.writeFileSync(path.join(repoDir(key), "state.json"), JSON.stringify({ lastSha: sh(repo, ["rev-parse", "HEAD~1"]), updatedAt: null }));
    expect((await runCapture(key, opts(fake()))).cardsWritten).toBe(1);
    expect(readCard(key, card.id).merge).toBe(sha);
  });

  it("skips a merge whose model output is unusable", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const report = await runCapture(key, opts(async () => "no idea"));
    expect(report).toMatchObject({ status: "done", skipped: 1 });
    expect(readState(key).lastSha).toBe(sha);
  });

  it("logs why drafted cards were rejected", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const run: RunClaude = async () => JSON.stringify([cardFor("src/elsewhere.ts"), cardFor("src/ref.ts", { startLine: 50, endLine: 60 })]);
    expect(await runCapture(key, opts(run))).toMatchObject({ processed: 1, cardsWritten: 0 });
    expect(log()).toContain("path not in the diff: src/elsewhere.ts");
    expect(log()).toContain("no usable anchor at src/ref.ts:50-60");
  });

  it("skips merges that only touch excluded files", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "package-lock.json": "{}\n" }, "chore: lockfile");
    expect((await runCapture(key, opts(fake()))).skipped).toBe(1);
    expect(readState(key).lastSha).toBe(sha);
    expect(log()).toContain("nothing to send");
  });

  it("skips and saves a merge whose diff is too large", async () => {
    await runCapture(key, opts(fake()));
    const sha = commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    let called = false;
    const run: RunClaude = async () => ((called = true), "[]");
    expect((await runCapture(key, opts(run, { maxDiffBytes: 50 }))).skipped).toBe(1);
    expect(called).toBe(false);
    expect(readState(key).lastSha).toBe(sha);
    expect(log()).toContain("skipped (shallow boundary or diff over 50 bytes)");
  });

  it("returns locked while another capture runs", async () => {
    const held = acquireLock(key)!;
    expect((await runCapture(key, opts(fake()))).status).toBe("locked");
    expect(fs.existsSync(lockFile())).toBe(true);
    held.release();
  });

  it("refreshes the lock after each merge and before checking anchors, and releases it", async () => {
    await runCapture(key, opts(fake()));
    commit(repo, { "src/a.ts": FILE }, "a");
    commit(repo, { "src/b.ts": FILE }, "b");
    hooks.refreshes = 0;
    hooks.releases = 0;
    await runCapture(key, opts(empty));
    // At least once per saved merge, plus once before the anchor loop.
    expect(hooks.refreshes).toBeGreaterThanOrEqual(3);
    expect(hooks.releases).toBe(1);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("logs an unexpected error, releases the lock and rethrows", async () => {
    await runCapture(key, opts(fake()));
    fs.writeFileSync(path.join(repoDir(key), "state.json"), "garbage");
    await expect(runCapture(key, opts(fake()))).rejects.toThrow(/state\.json is not valid JSON/);
    expect(log()).toMatch(/capture failed: .*state\.json is not valid JSON/);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it("recovers from rewritten history without duplicating cards", async () => {
    await runCapture(key, opts(fake()));
    const base = sh(repo, ["rev-parse", "HEAD"]);
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    await runCapture(key, opts(fake()));
    sh(repo, ["reset", "-q", "--hard", base]);
    const c = commit(repo, { "src/other.ts": FILE }, "feat: other");
    await runCapture(key, opts(fake("src/other.ts")));
    expect(listCards(key).map((x) => x.merge)).toContain(c);
    expect(listCards(key)).toHaveLength(2);
  });

  it("flags kept cards whose code changed", async () => {
    const [card] = await keptCards();
    commit(repo, { "src/ref.ts": FILE.replace("return null", "throw new Error('unknown')") }, "fix: throw");
    const report = await runCapture(key, opts(empty));
    expect(report.anchorsUpdated).toBe(1);
    expect(readCard(key, card.id).anchor.status).toBe("changed");
  });

  it("marks a card fresh without scanning when its file is unchanged", async () => {
    const [card] = await keptCards();
    writeCard(key, { ...card, anchor: { ...card.anchor, status: "changed" } });
    commit(repo, { "README.md": "more\n" }, "docs");
    hooks.statusChecks = 0;
    const report = await runCapture(key, opts(empty));
    expect(hooks.statusChecks).toBe(0);
    expect(report.anchorsUpdated).toBe(1);
    expect(readCard(key, card.id).anchor.status).toBe("fresh");
  });

  it("reads each changed file once per run", async () => {
    const cards = await keptCards(fakeTwo());
    expect(cards).toHaveLength(2);
    commit(repo, { "src/ref.ts": "// moved\n" + FILE.replace("return null", "throw new Error('unknown')") }, "fix: throw");
    hooks.fileReads = [];
    const report = await runCapture(key, opts(empty));
    expect(report.anchorsUpdated).toBe(2);
    expect(hooks.fileReads.filter((p) => p === "src/ref.ts")).toHaveLength(1);
  });

  it("doesn't revert a curate that happens while anchors are checked", async () => {
    const [card] = await keptCards();
    commit(repo, { "src/ref.ts": FILE.replace("return null", "throw new Error('unknown')") }, "fix: throw");
    hooks.beforeStatus = () => writeCard(key, { ...readCard(key, card.id), status: "dropped" });
    const report = await runCapture(key, opts(empty));
    expect(report.anchorsUpdated).toBe(0);
    expect(readCard(key, card.id)).toMatchObject({ status: "dropped", anchor: { status: "fresh" } });
  });

  it("logs a card that fails its anchor check and carries on", async () => {
    const [first, second] = await keptCards(fakeTwo());
    commit(repo, { "src/ref.ts": "// moved\n" + FILE.replace("return null", "throw new Error('unknown')") }, "fix: throw");
    let corrupted = false;
    hooks.beforeStatus = () => {
      if (!corrupted) fs.writeFileSync(cardPath(key, first.id), "nonsense");
      corrupted = true;
    };
    const report = await runCapture(key, opts(empty));
    expect(report).toMatchObject({ status: "done", anchorsUpdated: 1 });
    expect(readCard(key, second.id).anchor.status).toBe("changed");
    expect(log()).toContain(`anchor check for ${first.id} failed`);
  });
});
