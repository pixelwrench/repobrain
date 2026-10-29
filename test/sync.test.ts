import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileOAuthProvider } from "../src/auth.js";
import { main } from "../src/cli.js";
import type { Card } from "../src/format.js";
import { RemoteError, type Remote } from "../src/remote.js";
import { acquireLock, appendLog, connectRepo, loadConfig, readState, repoDir, setRemote, writeCard, writeState } from "../src/store.js";
import { BATCH_SIZE, cardHash, cut, linkRepo, refusalOf, submitPending, syncToSite, toSubmitted } from "../src/sync.js";
import { fakeRemote, submits } from "./fake-remote.js";
import { commit, makeRepo, useTempHome } from "./helpers.js";

const SITE = "http://localhost:3000";
const MERGE_A = "a".repeat(40);
const MERGE_B = "b".repeat(40);

function makeCard(key: string, id: string, over: Partial<Card> = {}): Card {
  return {
    id, repo: key, merge: MERGE_A, mergeTitle: "feat: referral codes", area: "src", createdAt: "2026-11-02T09:00:00.000Z", status: "draft", source: "merge",
    anchor: { commit: MERGE_A, path: "src/ref.ts", symbol: "applyReferral", startLine: 1, endLine: 5, lines: 5, fingerprint: "f".repeat(16), status: "fresh" },
    body: { kind: "flashcard", front: "What does applyReferral return for an unknown code?", back: "null" },
    ...over,
  };
}


describe("toSubmitted", () => {
  it("maps a card to the site's submittedCard shape, field for field", () => {
    const mcq = makeCard("k", "c1", {
      status: "kept",
      body: { kind: "mcq", question: "Q?", choices: ["a", "b", "c", "d"], correctChoice: 2, explanation: "Because." },
    });
    expect(toSubmitted(mcq)).toEqual({
      id: "c1", area: "src", status: "kept",
      body: { kind: "mcq", question: "Q?", choices: ["a", "b", "c", "d"], correctChoice: 2, explanation: "Because." },
      anchor: { commit: MERGE_A, path: "src/ref.ts", symbol: "applyReferral", startLine: 1, endLine: 5, fingerprint: "f".repeat(16), status: "fresh" },
    });
    expect(toSubmitted(makeCard("k", "c2")).body).toEqual({ kind: "flashcard", front: "What does applyReferral return for an unknown code?", back: "null" });
  });
});

describe("link and submitPending", () => {
  let repo: string;
  let key: string;
  beforeEach(() => {
    useTempHome();
    repo = makeRepo();
    commit(repo, { "README.md": "demo\n" }, "first");
    key = connectRepo(repo);
  });

  it("links the repo, stores the link, and uploads every card in batches of 20 per merge", async () => {
    const total = BATCH_SIZE + 3;
    for (let i = 0; i < total; i++) writeCard(key, makeCard(key, `a-${String(i).padStart(2, "0")}`, { status: i === 0 ? "kept" : i === 1 ? "dropped" : "draft" }));
    writeCard(key, makeCard(key, "b-1", { merge: MERGE_B, mergeTitle: "fix: totals" }));
    writeCard(key, makeCard(key, "base-1", { merge: MERGE_B, mergeTitle: "Baseline: Billing", source: "baseline" }));
    const remote = fakeRemote();
    const out = await linkRepo(key, repo, SITE, remote, () => new Date("2026-11-02T09:00:00Z"));
    expect(out).toEqual({ repoId: "repo-1", deckId: "deck-1", uploaded: total + 2, rejected: [] });
    expect(remote.calls[0]).toEqual({ tool: "link_repo", args: { key, name: repo.split("/").pop() } });
    const batches = submits(remote);
    expect(batches.map((b) => [b.merge, b.mergeTitle, b.source, b.cards.length])).toEqual([
      [MERGE_A, "feat: referral codes", "merge", BATCH_SIZE],
      [MERGE_A, "feat: referral codes", "merge", 3],
      [MERGE_B, "fix: totals", "merge", 1],
      [MERGE_B, "Baseline: Billing", "baseline", 1],
    ]);
    expect(batches.every((b) => b.repo === key)).toBe(true);
    expect(batches[0].cards.slice(0, 2).map((c) => c.status)).toEqual(["kept", "dropped"]);
    expect(loadConfig().repos[key].remote).toEqual({ site: SITE, repoId: "repo-1", deckId: "deck-1", linkedAt: "2026-11-02T09:00:00.000Z" });
  });

  it("reports rejected cards once, and sends one again only after it changes", async () => {
    writeCard(key, makeCard(key, "ok-1"));
    writeCard(key, makeCard(key, "bad-1"));
    const remote = fakeRemote({ reject: new Set(["bad-1"]) });
    const out = await linkRepo(key, repo, SITE, remote);
    expect(out.uploaded).toBe(1);
    expect(out.rejected).toEqual([{ id: "bad-1", reason: "looks like a secret" }]);
    const state = readState(key);
    expect(Object.keys(state.submitted ?? {})).toEqual(["ok-1"]);
    expect(state.refused).toEqual({ "bad-1": { hash: expect.any(String), reason: "looks like a secret" } });
    const again = fakeRemote();
    expect(await submitPending(key, again)).toEqual({ uploaded: 0, rejected: [] });
    expect(again.calls).toEqual([]);
    writeCard(key, makeCard(key, "bad-1", { body: { kind: "flashcard", front: "Fixed?", back: "Yes." } }));
    expect(await submitPending(key, again)).toEqual({ uploaded: 1, rejected: [] });
    expect(submits(again).flatMap((b) => b.cards.map((c) => c.id))).toEqual(["bad-1"]);
    expect(readState(key).refused).toEqual({});
  });

  it("keeps an old hash-only refusal mark, so that card isn't sent again until it changes", async () => {
    const card = makeCard(key, "bad-1");
    writeCard(key, card);
    writeState(key, { ...readState(key), refused: { "bad-1": cardHash(card) } });
    const remote = fakeRemote();
    expect(await submitPending(key, remote)).toEqual({ uploaded: 0, rejected: [] });
    expect(remote.calls).toEqual([]);
    expect(refusalOf(readState(key), "bad-1")).toEqual({ hash: cardHash(card), reason: null });
  });

  it("sends a card again when it changed after upload, and an old-style mark once", async () => {
    writeCard(key, makeCard(key, "c1"));
    writeCard(key, makeCard(key, "c2"));
    await submitPending(key, fakeRemote());
    expect(readState(key).submitted?.c1).toMatch(/^[0-9a-f]{64}$/);
    writeCard(key, makeCard(key, "c1", { body: { kind: "flashcard", front: "Re-drafted?", back: "Yes." } }));
    const state = readState(key);
    writeState(key, { ...state, submitted: { ...state.submitted, c2: true } });
    const again = fakeRemote();
    expect((await submitPending(key, again)).uploaded).toBe(2);
    expect(submits(again).flatMap((b) => b.cards.map((c) => [c.id, c.body.kind === "flashcard" ? c.body.front : ""]))).toEqual([
      ["c1", "Re-drafted?"],
      ["c2", "What does applyReferral return for an unknown code?"],
    ]);
    const third = fakeRemote();
    await submitPending(key, third);
    expect(third.calls).toEqual([]);
  });

  it("refreshes the caller's lock after each batch", async () => {
    for (let i = 0; i < BATCH_SIZE + 1; i++) writeCard(key, makeCard(key, `c-${String(i).padStart(2, "0")}`));
    let refreshes = 0;
    await submitPending(key, fakeRemote(), { refresh: () => refreshes++ });
    expect(refreshes).toBe(2);
  });

  it("refuses to link a repo whose key is too long for the site", async () => {
    await expect(linkRepo("x".repeat(81), repo, SITE, fakeRemote())).rejects.toThrow(/folder name is too long for the site/);
  });

  it("cuts long titles and names without splitting a character", async () => {
    expect(cut("ab\u{1F600}cd", 3)).toBe("ab");
    expect(cut("ab\u{1F600}cd", 4)).toBe("ab\u{1F600}");
    expect(cut("short", 300)).toBe("short");
    writeCard(key, makeCard(key, "c1", { mergeTitle: "x".repeat(299) + "\u{1F600}" }));
    const remote = fakeRemote();
    await submitPending(key, remote);
    expect(submits(remote)[0].mergeTitle).toBe("x".repeat(299));
  });

  it("sends nothing the second time", async () => {
    writeCard(key, makeCard(key, "c1"));
    await submitPending(key, fakeRemote());
    const again = fakeRemote();
    expect(await submitPending(key, again)).toEqual({ uploaded: 0, rejected: [] });
    expect(again.calls).toEqual([]);
  });

  it("holds back a card the site's schema would refuse, rather than failing its batch", async () => {
    writeCard(key, makeCard(key, "c1"));
    writeCard(key, makeCard(key, "c2", { body: { kind: "mcq", question: "Q?", choices: ["a", "b", "c", "d"], correctChoice: 0, explanation: "" } }));
    const remote = fakeRemote();
    const out = await submitPending(key, remote);
    expect(out).toEqual({ uploaded: 1, rejected: [{ id: "c2", reason: expect.stringMatching(/explanation/) }] });
    expect(submits(remote).flatMap((b) => b.cards.map((c) => c.id))).toEqual(["c1"]);
  });

  it("keeps the batches that got through when a later one fails", async () => {
    for (let i = 0; i < BATCH_SIZE + 1; i++) writeCard(key, makeCard(key, `c-${String(i).padStart(2, "0")}`));
    let n = 0;
    const remote = fakeRemote({ fail: (tool) => (tool === "submit_cards" && ++n === 2 ? new RemoteError("could not reach the site", "network") : null) });
    await expect(submitPending(key, remote)).rejects.toMatchObject({ kind: "network" });
    expect(Object.keys(readState(key).submitted ?? {})).toHaveLength(BATCH_SIZE);
  });

  it("is refused while a capture holds the repo's lock", async () => {
    const lock = acquireLock(key)!;
    try {
      await expect(linkRepo(key, repo, SITE, fakeRemote())).rejects.toThrow(/busy/);
    } finally {
      lock.release();
    }
  });

  it("stops a sync at its time budget and logs the step it timed out in", async () => {
    setRemote(key, { site: SITE, repoId: "repo-1", deckId: "deck-1", linkedAt: "2026-11-01T09:00:00.000Z" });
    new FileOAuthProvider(SITE).saveTokens({ access_token: "at-" + "x", token_type: "bearer" });
    for (let i = 0; i < BATCH_SIZE + 1; i++) writeCard(key, makeCard(key, `c-${String(i).padStart(2, "0")}`));
    const slow = fakeRemote({ delayMs: 10_000 });
    const started = Date.now();
    expect(await syncToSite(key, { connect: async () => slow, budgetMs: 300 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(submits(slow)).toHaveLength(1);
    expect(fs.readFileSync(path.join(repoDir(key), "capture.log"), "utf8")).toContain("site sync failed (network): timed out during submit_cards");
    expect(readState(key).remoteAuth).toBeUndefined();
  });

  it("stops a sync whose connect never finishes", async () => {
    setRemote(key, { site: SITE, repoId: "repo-1", deckId: "deck-1", linkedAt: "2026-11-01T09:00:00.000Z" });
    new FileOAuthProvider(SITE).saveTokens({ access_token: "at-" + "x", token_type: "bearer" });
    appendLog(key, "start");
    expect(await syncToSite(key, { connect: () => new Promise(() => {}), budgetMs: 200 })).toBe(0);
    expect(fs.readFileSync(path.join(repoDir(key), "capture.log"), "utf8")).toContain("timed out during connect");
  });

  describe("cli", () => {
    const cli = (args: string[], connect = async () => fakeRemote() as Remote) => main([...args, "--repo", repo], { connect });

    it("names repobrain login when the site has no sign-in", async () => {
      const out = await cli(["link", "--site", SITE]);
      expect(out).toEqual({ code: 1, out: { error: `not signed in to ${SITE}: run repobrain login --site ${SITE}` } });
    });

    it("names repobrain connect when the repo isn't connected", async () => {
      const other = makeRepo();
      const out = await main(["link", "--site", SITE, "--repo", other], { connect: async () => fakeRemote() });
      expect(out.code).toBe(1);
      expect((out.out as { error: string }).error).toMatch(/repobrain connect/);
    });

    it("links and unlinks", async () => {
      new FileOAuthProvider(SITE).saveTokens({ access_token: "at-" + "x", token_type: "bearer", refresh_token: "rt-" + "x" });
      writeCard(key, makeCard(key, "c1"));
      expect(await cli(["link", "--site", SITE])).toEqual({ code: 0, out: { repoId: "repo-1", deckId: "deck-1", uploaded: 1, rejected: [] } });
      expect(loadConfig().repos[key].remote?.site).toBe(SITE);
      expect(await cli(["unlink"])).toEqual({ code: 0, out: { unlinked: SITE } });
      expect(loadConfig().repos[key].remote).toBeUndefined();
      expect(await cli(["unlink"])).toEqual({ code: 0, out: { unlinked: null } });
    });

    it("reports a site failure as an error", async () => {
      new FileOAuthProvider(SITE).saveTokens({ access_token: "at-" + "x", token_type: "bearer" });
      const out = await cli(["link", "--site", SITE], async () => fakeRemote({ fail: () => new RemoteError("could not reach the site", "network") }));
      expect(out).toEqual({ code: 1, out: { error: "could not reach the site" } });
      expect(loadConfig().repos[key].remote).toBeUndefined();
    });
  });
});
