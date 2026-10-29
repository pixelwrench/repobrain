import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main, type CurateUnreadable, type DueOutput, type ShowOutput, type StatsOutput, type WeekOutput } from "../src/cli.js";
import { LETTERS, type Card } from "../src/format.js";
import { ClaudeEnvError, type RunClaude } from "../src/generate.js";
import { acquireLock, cardPath, findRepo, home, listCards, readCard, readJsonl, readState, repoDir, writeCard, writeState } from "../src/store.js";
import { commit, makeRepo, sh, tempDir, useTempHome } from "./helpers.js";
import { FileOAuthProvider, logout } from "../src/auth.js";
import { RemoteError } from "../src/remote.js";
import { callsTo, emptySiteWeek, fakeRemote, submits, type FakeRemote } from "./fake-remote.js";

const FILE = ["export function applyReferral(code: string) {", "  const ref = lookup(code);", "  if (!ref) return null;", "  return discount(ref);", "}", ""].join("\n");
const run: RunClaude = async () => ({
  text: JSON.stringify([
    { kind: "mcq", question: "What does applyReferral return for an unknown code?", choices: ["null", "an error", "zero", "the code"], correct: "A", explanation: "It returns null when lookup finds nothing.", path: "src/ref.ts", startLine: 1, endLine: 5, symbol: "applyReferral" },
    { kind: "flashcard", front: "Where are referral codes looked up?", back: "`lookup`, called by `applyReferral`", path: "src/ref.ts", startLine: 2, endLine: 4, symbol: "lookup" },
  ]),
  costUsd: null,
});
const now = () => new Date("2026-11-02T09:00:00Z");
const connectedKey = (dir: string): string => findRepo(dir)!.key;

describe("cli", () => {
  let repo: string;
  beforeEach(() => {
    useTempHome();
    repo = makeRepo();
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
  });
  const cli = (...argv: string[]) => main([...argv, "--repo", repo], { now, run });
  const connectAndCapture = async () => {
    const { connected } = (await cli("connect")).out as { connected: string };
    await cli("capture", "--since", "1 year ago", "--no-fetch");
    return connected;
  };
  const byKind = (key: string, kind: string): Card => listCards(key).find((c) => c.body.kind === kind)!;
  const keep = (key: string, card: Card, anchor: Partial<Card["anchor"]> = {}): Card => {
    const kept: Card = { ...card, status: "kept", anchor: { ...card.anchor, ...anchor } };
    writeCard(key, kept);
    return kept;
  };

  it("connects, captures, curates, reviews and reports stats", async () => {
    expect((await cli("connect")).code).toBe(0);
    const cap = await cli("capture", "--since", "1 year ago", "--no-fetch");
    expect(cap).toMatchObject({ code: 0, out: { status: "done", cardsWritten: 2 } });

    const week = (await cli("week")).out as WeekOutput;
    expect(week).toMatchObject({ drafts: 2, flagged: 0, unreadable: [], claudeUnavailable: null, stateError: null });
    expect(week.areas["src"][0].title).toBe("feat: referral codes");
    const [first, second] = week.areas["src"][0].cards.map((c) => c.id);

    expect((await cli("curate", first, "keep")).out).toEqual({ id: first, status: "kept", reanchored: false });
    expect((await cli("curate", second, "drop")).out).toEqual({ id: second, status: "dropped", reanchored: false });
    expect((await cli("week")).out).toEqual({ drafts: 0, flagged: 0, areas: {}, unreadable: [], claudeUnavailable: null, lastCaptureError: null, stateError: null });

    const due = (await cli("due")).out as DueOutput;
    expect(due.due.map((d) => d.id)).toEqual([first]);
    expect((await cli("grade", first, "right")).out).toEqual({ id: first, nextDue: "2026-11-05T09:00:00.000Z" });
    expect(((await cli("due")).out as DueOutput).due).toEqual([]);

    expect((await cli("stats")).out).toEqual({
      cards: 2, draft: 0, kept: 1, dropped: 1, changed: 0, orphaned: 0,
      curated: { keep: 1, fix: 0, drop: 1 }, reviews: 1, right: 1,
      bySource: {
        merge: { cards: 2, draft: 0, kept: 1, dropped: 1, curated: { keep: 1, fix: 0, drop: 1 } },
        baseline: { cards: 0, draft: 0, kept: 0, dropped: 0, curated: { keep: 0, fix: 0, drop: 0 } },
      },
      unreadable: [], claudeUnavailable: null, lastCaptureError: null, stateError: null,
    } satisfies StatsOutput);
  });

  describe("output shapes", () => {
    it("gives week cards their anchor, and mcq answers as a letter", async () => {
      const key = await connectAndCapture();
      const mcq = byKind(key, "mcq");
      const flash = byKind(key, "flashcard");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      expect(mcq.body.choices[mcq.body.correctChoice]).toBe("null");
      const cards = ((await cli("week")).out as WeekOutput).areas["src"][0].cards;
      expect(cards.find((c) => c.id === mcq.id)).toEqual({
        id: mcq.id, status: "draft", anchor: "fresh", path: "src/ref.ts", startLine: 1, endLine: 5, symbol: "applyReferral",
        body: {
          kind: "mcq", question: "What does applyReferral return for an unknown code?", choices: mcq.body.choices,
          correctChoice: mcq.body.correctChoice, correct: LETTERS[mcq.body.correctChoice], explanation: "It returns null when lookup finds nothing.",
        },
      });
      expect(cards.find((c) => c.id === flash.id)).toEqual({
        id: flash.id, status: "draft", anchor: "fresh", path: "src/ref.ts", startLine: 2, endLine: 4, symbol: "lookup",
        body: { kind: "flashcard", front: "Where are referral codes looked up?", back: "`lookup`, called by `applyReferral`" },
      });
    });

    it("gives due cards their area and whether their code changed, and never their answers", async () => {
      const key = await connectAndCapture();
      const mcq = keep(key, byKind(key, "mcq"), { status: "changed" });
      const flash = keep(key, byKind(key, "flashcard"));
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      const out = (await cli("due")).out as DueOutput;
      expect(out.due.find((d) => d.id === mcq.id)).toEqual({
        id: mcq.id, area: "src", path: "src/ref.ts", startLine: 1, endLine: 5, codeChanged: true,
        body: { kind: "mcq", question: "What does applyReferral return for an unknown code?", choices: mcq.body.choices },
      });
      expect(out.due.find((d) => d.id === flash.id)).toEqual({
        id: flash.id, area: "src", path: "src/ref.ts", startLine: 2, endLine: 4, codeChanged: false,
        body: { kind: "flashcard", front: "Where are referral codes looked up?" },
      });
      const printed = JSON.stringify(out);
      for (const secret of ["explanation", "correct", "back", "It returns null when lookup finds nothing.", "called by"]) expect(printed).not.toContain(secret);
    });

    it("gives a kept card's answer only through answer", async () => {
      const key = await connectAndCapture();
      const mcq = byKind(key, "mcq");
      const flash = byKind(key, "flashcard");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      expect(await cli("answer", mcq.id)).toMatchObject({ code: 1, out: { error: expect.stringMatching(/draft/) } });
      keep(key, mcq);
      keep(key, flash);
      expect(await cli("answer", mcq.id)).toEqual({
        code: 0, out: { id: mcq.id, kind: "mcq", correct: LETTERS[mcq.body.correctChoice], explanation: "It returns null when lookup finds nothing." },
      });
      expect(await cli("answer", flash.id)).toEqual({ code: 0, out: { id: flash.id, kind: "flashcard", back: "`lookup`, called by `applyReferral`" } });
      expect(await cli("answer", "deadbeef00-9")).toEqual({ code: 1, out: { error: "no card deadbeef00-9 in this repository" } });
      expect((await cli("answer", "../x")).code).toBe(2);
      expect((await cli("answer")).code).toBe(2);
    });
  });

  describe("baseline cards", () => {
    /** Two baseline areas sharing one commit, plus the merge's own cards. */
    const withBaseline = async () => {
      const key = await connectAndCapture();
      const [card] = listCards(key);
      const base = (n: number, area: string): Card => ({ ...card, id: `b${card.merge.slice(0, 8)}-a0${n}-x-1`, source: "baseline", mergeTitle: `Baseline: ${area}` });
      writeCard(key, base(1, "Entry points"));
      writeCard(key, base(2, "Referrals"));
      return { key, card, a: base(1, "Entry points"), b: base(2, "Referrals") };
    };

    it("groups week by commit and title, so each baseline area is its own group, and says each group's source", async () => {
      const { a, b } = await withBaseline();
      // Groups come in card-file order, which depends on the commit's SHA, so sort by title.
      const groups = ((await cli("week")).out as WeekOutput).areas["src"].sort((x, y) => x.title.localeCompare(y.title));
      expect(groups.map((g) => [g.title, g.source, g.cards.map((c) => c.id)])).toEqual([
        ["Baseline: Entry points", "baseline", [a.id]],
        ["Baseline: Referrals", "baseline", [b.id]],
        ["feat: referral codes", "merge", expect.any(Array)],
      ]);
      expect(groups[2].cards).toHaveLength(2);
    });

    it("splits stats by source, keeping the overall figures", async () => {
      const { card, a, b } = await withBaseline();
      await cli("curate", card.id, "keep");
      await cli("curate", a.id, "fix");
      await cli("curate", b.id, "drop");
      const stats = (await cli("stats")).out as StatsOutput;
      expect(stats).toMatchObject({ cards: 4, draft: 1, kept: 2, dropped: 1, curated: { keep: 1, fix: 1, drop: 1 } });
      expect(stats.bySource).toEqual({
        merge: { cards: 2, draft: 1, kept: 1, dropped: 0, curated: { keep: 1, fix: 0, drop: 0 } },
        baseline: { cards: 2, draft: 0, kept: 1, dropped: 1, curated: { keep: 0, fix: 1, drop: 1 } },
      });
    });
  });

  describe("baseline", () => {
    const areas = [{ name: "Referrals", why: "How codes become discounts", files: ["src/ref.ts"] }, { name: "Other", why: "w", files: ["src/ref.ts"] }];
    const planRun: RunClaude = async () => ({ text: JSON.stringify(areas), costUsd: 0.004 });
    const base = (argv: string[], r: RunClaude = run) => main(["baseline", ...argv, "--repo", repo], { now, run: r });

    it("plans, skips, drafts and reports status", async () => {
      await cli("connect");
      expect(await base(["status"])).toEqual({ code: 0, out: { plan: null, totals: null, costUsd: null } });
      expect(await base(["draft", "--next"])).toEqual({ code: 1, out: { error: "no baseline plan; run repobrain baseline plan first" } });
      const planned = await base(["plan", "--no-fetch"], planRun);
      expect(planned).toMatchObject({ code: 0, out: { existing: false, costUsd: 0.004, plan: { areas: [{ id: "a01-referrals" }, { id: "a02-other" }] } } });
      expect(await base(["plan", "--no-fetch"], planRun)).toMatchObject({ code: 0, out: { existing: true } });
      expect(await base(["skip", "a02-other"])).toMatchObject({ code: 0, out: { id: "a02-other", status: "skipped" } });
      expect(await base(["unskip", "a02-other"])).toMatchObject({ code: 0, out: { status: "planned" } });
      expect(await base(["skip", "a02-other"])).toMatchObject({ code: 0 });
      const drafted = await base(["draft", "--next"]);
      expect(drafted).toMatchObject({ code: 0, out: { area: { id: "a01-referrals", status: "drafted" }, cardsWritten: 2 } });
      expect(await base(["draft", "a01-referrals"])).toMatchObject({ code: 1, out: { error: expect.stringMatching(/already drafted/) } });
      expect(await base(["draft", "--next"])).toMatchObject({ code: 0, out: { area: null } });
      expect(await base(["status"])).toMatchObject({ code: 0, out: { totals: { drafted: 1, skipped: 1, cards: 2 }, costUsd: 0.004 } });
      const week = (await cli("week")).out as WeekOutput;
      expect(week.areas["src"].map((g) => g.title)).toEqual(["Baseline: Referrals"]);
    });

    it("exits 1 when drafting fails, and 2 on bad arguments", async () => {
      await cli("connect");
      await base(["plan", "--no-fetch"], planRun);
      const offline: RunClaude = async () => {
        throw new ClaudeEnvError("claude is offline");
      };
      expect(await base(["draft", "--next"], offline)).toMatchObject({ code: 1, out: { error: "claude is offline", area: { status: "planned" } } });
      for (const argv of [[], ["nope"], ["draft"], ["draft", "a01-referrals", "--next"], ["draft", "../x"], ["skip"], ["unskip", "a", "b"], ["status", "x"]]) {
        expect((await base(argv)).code).toBe(2);
      }
      expect((await base(["skip", "a09"])).code).toBe(1);
      const lock = acquireLock(connectedKey(repo))!;
      try {
        expect(await base(["skip", "a01-referrals"])).toEqual({ code: 1, out: { error: "busy, try again: a capture or baseline is running" } });
      } finally {
        lock.release();
      }
    });
  });

  it("records fix as kept, and logs the decision", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect((await cli("curate", card.id, "fix")).out).toEqual({ id: card.id, status: "kept", reanchored: false });
    expect(readCard(key, card.id).status).toBe("kept");
    expect(readJsonl(key, "curation.jsonl")).toEqual([{ card: card.id, decision: "fix", at: "2026-11-02T09:00:00.000Z" }]);
  });

  it("counts only each card's last decision in stats", async () => {
    const key = await connectAndCapture();
    const [a, b] = listCards(key);
    await cli("curate", a.id, "keep");
    await cli("curate", a.id, "drop");
    await cli("curate", b.id, "fix");
    await cli("curate", b.id, "keep");
    expect(((await cli("stats")).out as StatsOutput).curated).toEqual({ keep: 1, fix: 0, drop: 1 });
  });

  it("flags kept cards whose code changed in week", async () => {
    const key = await connectAndCapture();
    const card = keep(key, listCards(key)[0], { status: "changed" });
    const week = (await cli("week")).out as WeekOutput;
    expect(week).toMatchObject({ drafts: 1, flagged: 1 });
    expect(week.areas["src"][0].cards.find((c) => c.id === card.id)?.anchor).toBe("changed");
  });

  describe("curating a flagged card", () => {
    it("re-anchors a kept, changed card at the default branch's head, so week stops flagging it", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"));
      const head = commit(repo, { "src/ref.ts": FILE.replace("return null", "return undefined") }, "fix: undefined");
      writeCard(key, { ...readCard(key, card.id), anchor: { ...card.anchor, status: "changed" } });

      for (const decision of ["keep", "fix"]) {
        if (decision === "fix") writeCard(key, { ...readCard(key, card.id), anchor: { ...card.anchor, status: "changed" } });
        expect(await cli("curate", card.id, decision)).toEqual({
          code: 0, out: { id: card.id, status: "kept", reanchored: true, path: "src/ref.ts", startLine: 1, endLine: 5 },
        });
        const after = readCard(key, card.id).anchor;
        expect(after).toMatchObject({ commit: head, path: "src/ref.ts", status: "fresh", startLine: 1, endLine: 5 });
        expect(after.fingerprint).not.toBe(card.anchor.fingerprint);
      }
      expect((await cli("week")).out).toMatchObject({ flagged: 0 });
    });

    const ABOVE = "// one\n// two\n// three\n";

    it("follows the symbol when lines are inserted above the block", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"));
      expect(card.anchor).toMatchObject({ symbol: "applyReferral", startLine: 1, endLine: 5 });
      const head = commit(repo, { "src/ref.ts": ABOVE + FILE.replace("return null", "return undefined") }, "fix: undefined");
      writeCard(key, { ...card, anchor: { ...card.anchor, status: "changed" } });
      expect(await cli("curate", card.id, "keep")).toEqual({
        code: 0, out: { id: card.id, status: "kept", reanchored: true, path: "src/ref.ts", startLine: 4, endLine: 8 },
      });
      expect(readCard(key, card.id).anchor).toMatchObject({ commit: head, symbol: "applyReferral", startLine: 4, endLine: 8, status: "fresh" });
    });

    it("takes the occurrence of the symbol nearest the old block", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "flashcard"));
      expect(card.anchor).toMatchObject({ symbol: "lookup", startLine: 2, endLine: 4 });
      // `lookup` now also appears far below, and in a longer word that isn't a whole-word match.
      const after = ABOVE + FILE.replace("return null", "return undefined") + "\n".repeat(20) + "// lookupTable, then lookup again\n";
      commit(repo, { "src/ref.ts": after }, "fix: undefined");
      writeCard(key, { ...card, anchor: { ...card.anchor, status: "changed" } });
      expect((await cli("curate", card.id, "keep")).out).toMatchObject({ reanchored: true, startLine: 5, endLine: 7 });
    });

    it("keeps line-based re-anchoring for a card with no symbol", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { symbol: null });
      commit(repo, { "src/ref.ts": ABOVE + FILE }, "docs: comments");
      writeCard(key, { ...card, anchor: { ...card.anchor, status: "changed" } });
      expect((await cli("curate", card.id, "keep")).out).toMatchObject({ reanchored: true, startLine: 1, endLine: 5 });
    });

    it("refuses when the symbol is gone at head", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { status: "changed" });
      commit(repo, { "src/ref.ts": FILE.replace("applyReferral", "redeemReferral") }, "refactor: rename");
      const before = fs.readFileSync(cardPath(key, card.id), "utf8");
      expect(await cli("curate", card.id, "keep")).toEqual({ code: 1, out: { error: `can't re-anchor ${card.id}: re-point it with \`curate ${card.id} fix --path P --lines S-E\`, or drop it` } });
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
    });

    it("re-anchors against the default branch, not the checked-out branch", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { status: "changed" });
      const head = sh(repo, ["rev-parse", "master"]);
      sh(repo, ["checkout", "-q", "-b", "wip"]);
      commit(repo, { "src/ref.ts": "gone\n" }, "wip");
      expect((await cli("curate", card.id, "keep")).code).toBe(0);
      expect(readCard(key, card.id).anchor).toMatchObject({ commit: head, status: "fresh" });
    });

    it("refuses, and leaves the card alone, when the code can't be re-anchored", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "flashcard"), { status: "changed" });
      expect(card.anchor.startLine).toBeGreaterThan(1);
      commit(repo, { "src/ref.ts": "x\n" }, "refactor: shrink");
      const before = fs.readFileSync(cardPath(key, card.id), "utf8");
      expect(await cli("curate", card.id, "fix")).toEqual({ code: 1, out: { error: `can't re-anchor ${card.id}: re-point it with \`curate ${card.id} fix --path P --lines S-E\`, or drop it` } });
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
      expect(readJsonl(key, "curation.jsonl")).toEqual([]);
    });

    it("refuses to keep or fix an orphaned card, but lets it be dropped", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { status: "orphaned" });
      for (const decision of ["keep", "fix"]) {
        expect(await cli("curate", card.id, decision)).toEqual({ code: 1, out: { error: `the code for ${card.id} was removed; drop it, or re-point it with \`curate ${card.id} fix --path P --lines S-E\`` } });
      }
      expect(readCard(key, card.id)).toEqual(card);
      expect((await cli("curate", card.id, "drop")).out).toMatchObject({ status: "dropped" });
    });
  });

  it("reports a fix that broke the card file, in curate, week and stats", async () => {
    const key = await connectAndCapture();
    const card = byKind(key, "mcq");
    const file = cardPath(key, card.id);
    const broken = fs.readFileSync(file, "utf8").replace(/^Correct: .*\n/m, "");
    fs.writeFileSync(file, broken);

    const reason = "Correct must be A, B, C or D";
    expect(await cli("curate", card.id, "fix")).toEqual({
      code: 1,
      out: { error: `the edit broke the card: ${reason}; fix the file and run curate again`, unreadable: true, path: file, reason } satisfies CurateUnreadable,
    });
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(broken).toContain('status: "draft"');
    const week = (await cli("week")).out as WeekOutput;
    expect(week.unreadable).toEqual([{ file, error: reason }]);
    expect(week.drafts).toBe(1);
    expect(((await cli("stats")).out as StatsOutput).unreadable).toEqual([{ file, error: reason }]);
  });

  it("shows in week and stats when capture can't reach claude", async () => {
    const key = await connectAndCapture();
    const unavailable = { since: "2026-11-01T08:00:00.000Z", message: "spawn claude ENOENT" };
    writeState(key, { ...readState(key), unavailable });
    expect(((await cli("week")).out as WeekOutput).claudeUnavailable).toEqual(unavailable);
    expect(((await cli("stats")).out as StatsOutput).claudeUnavailable).toEqual(unavailable);
  });

  it("shows the last capture error in week and stats", async () => {
    const key = await connectAndCapture();
    const lastError = { at: "2026-11-01T08:00:00.000Z", message: "fatal: bad pathspec" };
    writeState(key, { ...readState(key), lastError });
    expect(((await cli("week")).out as WeekOutput).lastCaptureError).toEqual(lastError);
    expect(((await cli("stats")).out as StatsOutput).lastCaptureError).toEqual(lastError);
  });

  it("still shows week and stats when state.json is corrupt, and reports the error", async () => {
    const key = await connectAndCapture();
    fs.writeFileSync(path.join(repoDir(key), "state.json"), "{not json");
    const week = await cli("week");
    expect(week.code).toBe(0);
    expect(week.out as WeekOutput).toMatchObject({ drafts: 2, claudeUnavailable: null, stateError: expect.stringContaining(path.join(repoDir(key), "state.json")) });
    const stats = await cli("stats");
    expect(stats.code).toBe(0);
    expect(stats.out as StatsOutput).toMatchObject({ cards: 2, claudeUnavailable: null, stateError: expect.stringContaining(path.join(repoDir(key), "state.json")) });
  });

  it("works from a linked worktree of a connected repo", async () => {
    await connectAndCapture();
    const wt = path.join(tempDir("repobrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const week = await main(["week", "--repo", wt], { now, run });
    expect(week.code).toBe(0);
    expect((week.out as WeekOutput).drafts).toBe(2);
  });

  describe("show", () => {
    const BLOCK = FILE.split("\n").slice(0, 5).join("\n");

    it("returns the anchored block's code at the default branch's head", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const head = sh(repo, ["rev-parse", "master"]);
      expect(await cli("show", card.id)).toEqual({
        code: 0,
        out: { id: card.id, status: "draft", anchor: "fresh", path: "src/ref.ts", startLine: 1, endLine: 5, atHead: { commit: head, startLine: 1, endLine: 5, symbolFound: true, lines: BLOCK },
          atCommit: { commit: card.anchor.commit, lines: BLOCK },
        } satisfies ShowOutput,
      });
    });

    it("follows the symbol at head, and falls back to the same lines without one", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const changed = FILE.replace("return null", "return undefined");
      const head = commit(repo, { "src/ref.ts": "// one\n// two\n// three\n" + changed }, "fix: undefined");
      const shown = (await cli("show", card.id)).out as ShowOutput;
      expect(shown.atHead).toEqual({ commit: head, startLine: 4, endLine: 8, symbolFound: true, lines: changed.split("\n").slice(0, 5).join("\n") });
      expect(shown.atCommit).toEqual({ commit: card.anchor.commit, lines: FILE.split("\n").slice(0, 5).join("\n") });
      writeCard(key, { ...card, anchor: { ...card.anchor, symbol: null } });
      expect(((await cli("show", card.id)).out as ShowOutput).atHead).toEqual({
        commit: head, startLine: 1, endLine: 5, symbolFound: false, lines: ["// one", "// two", "// three", "export function applyReferral(code: string) {", "  const ref = lookup(code);"].join("\n"),
      });
      // A symbol gone at head also falls back to the same lines.
      commit(repo, { "src/ref.ts": FILE.replace("lookup", "findReferral") }, "refactor: rename");
      expect(((await cli("show", byKind(key, "flashcard").id)).out as ShowOutput).atHead).toMatchObject({ startLine: 2, endLine: 4, symbolFound: false });
    });

    it("clamps the range at head to the file's last line", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const short = FILE.split("\n").slice(0, 3).join("\n") + "\n";
      commit(repo, { "src/ref.ts": short }, "refactor: shorter");
      expect(((await cli("show", card.id)).out as ShowOutput).atHead).toMatchObject({
        startLine: 1, endLine: 3, symbolFound: true, lines: short.trimEnd(),
      });
    });

    it("gives null lines when the file is gone at head, and errors for unknown or bad ids", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      commit(repo, { "src/ref.ts": null, "README.md": "x\n" }, "chore: remove");
      const shown = (await cli("show", card.id)).out as ShowOutput;
      expect(shown.atHead).toMatchObject({ lines: null, symbolFound: false });
      expect(shown.atCommit.lines).toBe(FILE.split("\n").slice(0, 5).join("\n"));
      expect(await cli("show", "deadbeef00-9")).toEqual({ code: 1, out: { error: "no card deadbeef00-9 in this repository" } });
      expect((await cli("show", "../x")).code).toBe(2);
      expect((await cli("show")).code).toBe(2);
    });
  });

  describe("re-pointing a card with fix --path --lines", () => {
    it("re-points a kept, changed card at the given lines", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "flashcard"), { status: "changed" });
      const head = commit(repo, { "src/ref.ts": "// moved down\n\n" + FILE }, "docs: comment");
      expect(await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "4-6")).toEqual({
        code: 0, out: { id: card.id, status: "kept", reanchored: true, path: "src/ref.ts", startLine: 4, endLine: 6 },
      });
      expect(readCard(key, card.id)).toMatchObject({ status: "kept", anchor: { commit: head, path: "src/ref.ts", startLine: 4, endLine: 6, symbol: "lookup", status: "fresh" } });
      expect(readJsonl(key, "curation.jsonl")).toEqual([{ card: card.id, decision: "fix", at: "2026-11-02T09:00:00.000Z" }]);
    });

    it("re-points an orphaned card at a moved file, and takes the area from the new path", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { status: "orphaned" });
      const head = commit(repo, { "src/ref.ts": null, "lib/referrals/ref.ts": FILE }, "refactor: move");
      expect((await cli("curate", card.id, "fix", "--path", "lib/referrals/ref.ts", "--lines", "1-5", "--no-symbol")).out).toEqual({
        id: card.id, status: "kept", reanchored: true, path: "lib/referrals/ref.ts", startLine: 1, endLine: 5,
      });
      expect(readCard(key, card.id)).toMatchObject({
        area: "lib/referrals", anchor: { commit: head, path: "lib/referrals/ref.ts", symbol: null, status: "fresh" },
      });
    });

    it("re-points a draft, with an explicit symbol, and keeps it", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      expect((await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "3-4", "--symbol", "discount")).out).toMatchObject({ reanchored: true, startLine: 3, endLine: 4 });
      expect(readCard(key, card.id)).toMatchObject({ status: "kept", anchor: { startLine: 3, endLine: 4, symbol: "discount" } });
    });

    it("rejects a bad range or path with code 2, and leaves the card alone", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const before = fs.readFileSync(cardPath(key, card.id), "utf8");
      const fix = (...flags: string[]) => cli("curate", card.id, "fix", ...flags);
      for (const lines of ["5-2", "0-3", "a-b", "3", "1-2-3", ""]) {
        expect(await fix("--path", "src/ref.ts", "--lines", lines)).toEqual({ code: 2, out: { error: "--lines must be S-E with positive integers and S <= E" } });
      }
      for (const p of ["../x.ts", "/etc/hosts", "src/../../x.ts", "", ".", "src\\ref.ts"]) {
        expect(await fix("--path", p, "--lines", "1-5")).toEqual({ code: 2, out: { error: "--path must be a relative path inside the repository, with no .." } });
      }
      expect((await fix("--path", "src/ref.ts")).code).toBe(2);
      expect((await fix("--lines", "1-5")).code).toBe(2);
      expect((await fix("--path", "src/ref.ts", "--lines", "1-5", "--symbol", "x", "--no-symbol")).code).toBe(2);
      expect((await cli("curate", card.id, "keep", "--path", "src/ref.ts", "--lines", "1-5")).code).toBe(2);
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
    });

    it("returns code 1 when the code there can't hold an anchor, or the card can't be re-pointed", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const before = fs.readFileSync(cardPath(key, card.id), "utf8");
      expect(await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "50-60")).toEqual({
        code: 1, out: { error: `can't anchor ${card.id} at src/ref.ts:50-60 on master: the file is missing there, or those lines are out of range or too trivial` },
      });
      expect((await cli("curate", card.id, "fix", "--path", "src/nope.ts", "--lines", "1-5")).code).toBe(1);
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
      writeCard(key, { ...card, status: "dropped" });
      expect(await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "1-5")).toEqual({
        code: 1, out: { error: `card ${card.id} is dropped; only cards that aren't dropped can be re-pointed` },
      });
    });

    it("re-points a fresh kept card, such as one a re-anchor put on the wrong code", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"));
      expect((await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "3-4", "--symbol", "discount")).out).toEqual({
        id: card.id, status: "kept", reanchored: true, path: "src/ref.ts", startLine: 3, endLine: 4,
      });
      expect(readCard(key, card.id).anchor).toMatchObject({ startLine: 3, endLine: 4, symbol: "discount", status: "fresh" });
    });

    it("refuses an explicit --symbol that isn't in the file at head, and leaves the card alone", async () => {
      const key = await connectAndCapture();
      const card = byKind(key, "mcq");
      const before = fs.readFileSync(cardPath(key, card.id), "utf8");
      for (const symbol of ["redeemReferral", "lookupTable", "apply"]) {
        expect(await cli("curate", card.id, "fix", "--path", "src/ref.ts", "--lines", "1-5", "--symbol", symbol)).toEqual({
          code: 1, out: { error: `symbol ${symbol} not found in src/ref.ts at HEAD` },
        });
      }
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
      expect(readJsonl(key, "curation.jsonl")).toEqual([]);
    });
  });

  it("connects the main repo from a linked worktree", async () => {
    const wt = path.join(tempDir("repobrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const fromWt = (await main(["connect", "--repo", wt], { now, run })).out as { connected: string };
    expect(fromWt.connected).toBe(((await cli("connect")).out as { connected: string }).connected);
  });

  it("limits due cards", async () => {
    const key = await connectAndCapture();
    for (const c of listCards(key)) await cli("curate", c.id, "keep");
    expect(((await cli("due", "--limit", "1")).out as DueOutput).due).toHaveLength(1);
    expect((await cli("due", "--limit", "0")).code).toBe(2);
  });

  it("returns a card's file path, or code 1 when it doesn't exist", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect((await cli("card", card.id)).out).toEqual({ path: path.join(repoDir(key), "cards", `${card.id}.md`) });
    expect(await cli("card", "deadbeef00-9")).toEqual({ code: 1, out: { error: "no card deadbeef00-9 in this repository" } });
  });

  it("rejects bad arguments with exit code 2", async () => {
    await cli("connect");
    expect((await cli("curate", "x", "maybe")).code).toBe(2);
    expect((await cli("grade", "x", "sort-of")).code).toBe(2);
    expect((await cli("due", "--bogus")).code).toBe(2);
    expect((await cli("capture", "--max", "lots")).code).toBe(2);
    expect((await cli("connect", "--area-depth", "-1")).code).toBe(2);
    expect((await main(["nonsense"])).code).toBe(2);
    expect((await main([])).code).toBe(2);
    expect((await main(["nonsense"])).out).toMatchObject({ error: expect.stringMatching(/usage/) });
  });

  it("rejects unsafe card ids with exit code 2, and unknown ones with exit code 1", async () => {
    await connectAndCapture();
    for (const cmd of ["curate", "grade"]) {
      const decision = cmd === "curate" ? "keep" : "right";
      for (const id of ["../config", "a/b", ".hidden"]) {
        const r = await cli(cmd, id, decision);
        expect(r).toMatchObject({ code: 2, out: { error: expect.stringMatching(/invalid card id/) } });
      }
      expect(await cli(cmd, "deadbeef00-9", decision)).toEqual({ code: 1, out: { error: "no card deadbeef00-9 in this repository" } });
    }
    expect((await cli("card", "../x")).code).toBe(2);
  });

  it("only grades kept cards", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect(await cli("grade", card.id, "right")).toMatchObject({ code: 1, out: { error: expect.stringMatching(/draft/) } });
    expect(readJsonl(key, "reviews.jsonl")).toEqual([]);
  });

  it("explains how to connect an unconnected repo, without throwing", async () => {
    expect(await cli("due")).toEqual({ code: 1, out: { error: expect.stringMatching(/repobrain connect/) } });
  });

  it("returns errors instead of throwing", async () => {
    await cli("connect");
    fs.writeFileSync(path.join(home(), "config.json"), "{not json");
    for (const cmd of ["week", "due", "stats", "connect"]) {
      expect(await cli(cmd)).toEqual({ code: 1, out: { error: expect.stringMatching(/not valid JSON/) } });
    }
  });

  it("logs a capture in an unconnected repo to capture-errors.log", async () => {
    expect(await cli("capture", "--no-fetch")).toEqual({ code: 1, out: { error: expect.stringMatching(/repobrain connect/) } });
    const log = fs.readFileSync(path.join(home(), "capture-errors.log"), "utf8");
    expect(log).toContain(repo);
    expect(log).toMatch(/repobrain connect/);
  });

  it("logs a capture outside any git repository to capture-errors.log", async () => {
    const dir = tempDir("repobrain-nogit-");
    expect((await main(["capture", "--repo", dir], { now, run })).code).toBe(1);
    expect(fs.readFileSync(path.join(home(), "capture-errors.log"), "utf8")).toContain(dir);
  });

  it("logs a failed capture to the repo's capture.log exactly once", async () => {
    const { connected } = (await cli("connect")).out as { connected: string };
    fs.writeFileSync(path.join(repoDir(connected), "state.json"), "{not json");
    expect(await cli("capture", "--no-fetch")).toEqual({ code: 1, out: { error: expect.stringMatching(/not valid JSON/) } });
    const log = fs.readFileSync(path.join(repoDir(connected), "capture.log"), "utf8");
    expect(log.match(/not valid JSON/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(home(), "capture-errors.log"))).toBe(false);
  });

  it("logs bad capture arguments to the repo's capture.log", async () => {
    const { connected } = (await cli("connect")).out as { connected: string };
    expect((await cli("capture", "--max", "0")).code).toBe(2);
    expect(fs.readFileSync(path.join(repoDir(connected), "capture.log"), "utf8")).toMatch(/--max/);
  });
});

describe("the repobrain binary", () => {
  let bin: string;
  beforeAll(() => {
    // Build to a temp dir, with this repo's node_modules linked in so ts-fsrs resolves.
    const out = tempDir("repobrain-bin-");
    const root = path.resolve(import.meta.dirname, "..");
    execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(root, "tsconfig.build.json"), "--outDir", out]);
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n');
    fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"));
    bin = path.join(out, "bin.js");
  });

  const spawn = (args: string[]) => {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env } });
    return { code: r.status, out: JSON.parse(r.stdout) as Record<string, unknown>, stderr: r.stderr };
  };

  it("prints JSON, sets the exit code, and never prints a stack trace", () => {
    useTempHome();
    const repo = makeRepo();
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");

    const unconnected = spawn(["due", "--repo", repo]);
    expect(unconnected).toMatchObject({ code: 1, out: { error: expect.stringMatching(/repobrain connect/) } });
    expect(unconnected.stderr).not.toMatch(/\n\s+at /);

    expect(spawn(["connect", "--repo", repo])).toMatchObject({ code: 0, out: { connected: expect.any(String) } });
    expect(spawn(["stats", "--repo", repo])).toMatchObject({ code: 0, out: { cards: 0 } });
    const bad = spawn(["grade", "../x", "right", "--repo", repo]);
    expect(bad).toMatchObject({ code: 2, out: { error: 'invalid card id "../x"' } });
    expect(bad.stderr).toBe("");
  });
});

describe("cli with a repo linked to the site", () => {
  const SITE = "http://localhost:3000";
  const MCQ_ID = "11111111-1111-4111-8111-111111111111";
  const FLASH_ID = "22222222-2222-4222-8222-222222222222";
  let repo: string;
  let key: string;
  let remote: FakeRemote;
  let connects: number;
  const cli = (...argv: string[]) => main([...argv, "--repo", repo], { now, run, connect: async () => (connects++, remote) });
  const byKind = (kind: string): Card => listCards(key).find((c) => c.body.kind === kind)!;
  /** The site's copies of the local cards, as get_due_cards and get_deck list them. */
  /** The site's copies of the local cards, as get_due_cards and get_deck list them, with the site's anchor. */
  const siteCards = () => {
    const [mcqCard, flashCard] = [byKind("mcq"), byKind("flashcard")];
    const mcq = mcqCard.body as Extract<Card["body"], { kind: "mcq" }>;
    const flash = flashCard.body as Extract<Card["body"], { kind: "flashcard" }>;
    const repoCard = (c: Card) => ({ id: c.id, path: c.anchor.path, startLine: c.anchor.startLine, endLine: c.anchor.endLine, status: c.anchor.status });
    return [
      { id: MCQ_ID, kind: "MULTIPLE_CHOICE", term: mcq.question, definition: mcq.choices[mcq.correctChoice], choices: mcq.choices, explanation: mcq.explanation, repoCard: repoCard(mcqCard) },
      { id: FLASH_ID, term: flash.front, definition: flash.back, repoCard: repoCard(flashCard) },
    ];
  };

  beforeEach(async () => {
    useTempHome();
    repo = makeRepo();
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    connects = 0;
    remote = fakeRemote();
    key = ((await cli("connect")).out as { connected: string }).connected;
    await cli("capture", "--since", "1 year ago", "--no-fetch");
    new FileOAuthProvider(SITE).saveTokens({ access_token: "at-" + "x", token_type: "bearer" });
    expect((await main(["link", "--site", SITE, "--repo", repo], { connect: async () => remote })).code).toBe(0);
    remote = fakeRemote();
  });

  describe("week", () => {
    it("uploads pending cards first, then prints the site's week with the local status and the site", async () => {
      writeCard(key, { ...byKind("flashcard"), id: "late-1" });
      const siteWeek = { ...emptySiteWeek(), drafts: 3, lesson: { title: "This week", deckId: "deck-1" } };
      remote = fakeRemote({ answers: { get_week: () => siteWeek } });
      writeState(key, { ...readState(key), lastError: { at: "2026-11-01T09:00:00.000Z", message: "git broke" } });
      const r = await cli("week");
      expect(r).toEqual({ code: 0, out: { ...siteWeek, lastCaptureError: { at: "2026-11-01T09:00:00.000Z", message: "git broke" }, site: SITE, weekUrl: `${SITE}/repos/repo-1/week`, remote: true } });
      expect(remote.calls.map((c) => c.tool)).toEqual(["submit_cards", "get_week"]);
      expect(remote.calls[1]).toMatchObject({ args: { repo: key }, opts: { timeout: 30_000 } });
    });

    it("prints the local week with remoteError when the site fails", async () => {
      remote = fakeRemote({ fail: (tool) => (tool === "get_week" ? new RemoteError("could not reach the site", "network") : null) });
      const r = await cli("week");
      expect(r.code).toBe(0);
      expect(r.out).toMatchObject({ drafts: 2, flagged: 0, site: SITE, remote: false, remoteError: "could not reach the site" });
      expect((r.out as WeekOutput).areas["src"][0].cards).toHaveLength(2);
      expect(r.out).not.toHaveProperty("loginHint");
    });

    it("says to run repobrain login when the site refuses the sign-in", async () => {
      remote = fakeRemote({ fail: (tool) => (tool === "get_week" ? new RemoteError("not signed in", "auth") : null) });
      const r = await cli("week");
      expect(r.out).toMatchObject({ remote: false, loginHint: expect.stringMatching(/repobrain login/) });
      expect(readState(key).remoteAuth).toBe("expired");
      remote = fakeRemote();
      const again = await cli("week");
      expect(again.out).toMatchObject({ remote: true });
      expect(again.out).not.toHaveProperty("loginHint");
      expect(readState(key).remoteAuth).toBeUndefined();
    });

    it("doesn't connect when this machine isn't signed in", async () => {
      logout(SITE);
      const r = await cli("week");
      expect(r.out).toMatchObject({ drafts: 2, remote: false, remoteError: expect.stringMatching(/repobrain login/) });
      expect(connects).toBe(0);
    });
  });

  describe("curate", () => {
    it("saves keep and drop on the site and in the local file", async () => {
      const mcq = byKind("mcq");
      const flash = byKind("flashcard");
      expect(await cli("curate", mcq.id, "keep")).toEqual({ code: 0, out: { id: mcq.id, status: "kept", reanchored: false } });
      expect(await cli("curate", flash.id, "drop")).toEqual({ code: 0, out: { id: flash.id, status: "dropped", reanchored: false } });
      expect(callsTo(remote, "curate_card")).toEqual([{ repo: key, id: mcq.id, decision: "keep" }, { repo: key, id: flash.id, decision: "drop" }]);
      expect(remote.calls.every((c) => c.opts?.timeout === 30_000)).toBe(true);
      expect(readCard(key, mcq.id).status).toBe("kept");
      expect(readCard(key, flash.id).status).toBe("dropped");
      expect(readJsonl(key, "curation.jsonl")).toHaveLength(2);
    });

    it("sends a fix with the edited card's body", async () => {
      const mcq = byKind("mcq");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      const body = { ...mcq.body, question: "What does applyReferral give back for a code it can't find?" };
      writeCard(key, { ...mcq, body });
      expect((await cli("curate", mcq.id, "fix")).out).toEqual({ id: mcq.id, status: "kept", reanchored: false });
      expect(callsTo(remote, "curate_card")).toEqual([{ repo: key, id: mcq.id, decision: "fix", body }]);
      expect(readCard(key, mcq.id)).toMatchObject({ status: "kept", body });
    });

    it("leaves the local file alone when the site refuses", async () => {
      const mcq = byKind("mcq");
      remote = fakeRemote({ fail: (tool) => (tool === "curate_card" ? new RemoteError("no card in this repo", "tool") : null) });
      expect(await cli("curate", mcq.id, "keep")).toEqual({ code: 1, out: { error: "no card in this repo" } });
      expect(readCard(key, mcq.id).status).toBe("draft");
      expect(readJsonl(key, "curation.jsonl")).toEqual([]);
    });

    it("uploads a card the site doesn't have yet before curating it", async () => {
      const late = { ...byKind("flashcard"), id: "late-1" };
      writeCard(key, late);
      await cli("curate", "late-1", "keep");
      expect(remote.calls.map((c) => c.tool)).toEqual(["submit_cards", "curate_card"]);
    });

    it("sends a re-pointed card's new anchor right after the fix", async () => {
      const flash = byKind("flashcard");
      commit(repo, { "src/ref.ts": "// moved down\n\n" + FILE }, "docs: comment");
      expect((await cli("curate", flash.id, "fix", "--path", "src/ref.ts", "--lines", "4-6")).out).toMatchObject({ reanchored: true, startLine: 4 });
      expect(remote.calls.map((c) => c.tool)).toEqual(["curate_card", "submit_cards"]);
      expect(submits(remote)[0].cards).toEqual([expect.objectContaining({ id: flash.id, status: "kept", anchor: expect.objectContaining({ startLine: 4, endLine: 6 }) })]);
    });
  });

  describe("review", () => {
    it("lists the site's due cards by their site ids, with the site's anchor and the plugin's card id", async () => {
      const [mcqSite, flashSite] = siteCards();
      // The site's anchor wins: it says the code changed, and the text there differs from the local file.
      const flashChanged = { ...flashSite, term: "Edited on the site", repoCard: { ...flashSite.repoCard, startLine: 3, status: "changed" } };
      const gone = { id: "33333333-3333-4333-8333-333333333333", term: "No local file", definition: "x", repoCard: { id: "gone-1", path: "lib/x.ts", startLine: 7, endLine: 9, status: "orphaned" } };
      const plain = { id: "55555555-5555-4555-8555-555555555555", term: "Not a repo card", definition: "y" };
      remote = fakeRemote({ answers: { get_due_cards: () => ({ deckId: "deck-1", cards: [mcqSite, flashChanged, gone, plain] }) } });
      const mcq = byKind("mcq");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      const r = await cli("due", "--limit", "5");
      expect(r).toEqual({
        code: 0,
        out: {
          site: SITE, remote: true,
          due: [
            { id: MCQ_ID, localId: mcq.id, area: "src", path: "src/ref.ts", startLine: 1, endLine: 5, codeChanged: false, body: { kind: "mcq", question: mcq.body.question, choices: mcq.body.choices } },
            { id: FLASH_ID, localId: byKind("flashcard").id, area: "src", path: "src/ref.ts", startLine: 3, endLine: 4, codeChanged: true, body: { kind: "flashcard", front: "Edited on the site" } },
            { id: gone.id, localId: null, area: null, path: "lib/x.ts", startLine: 7, endLine: 9, codeChanged: true, body: { kind: "flashcard", front: "No local file" } },
            { id: plain.id, localId: null, area: null, path: null, startLine: null, endLine: null, codeChanged: false, body: { kind: "flashcard", front: "Not a repo card" } },
          ],
        },
      });
      expect(callsTo(remote, "get_due_cards")).toEqual([{ deckId: "deck-1" }]);
      expect(remote.calls[0].opts).toEqual({ timeout: 30_000 });
    });

    it("gives the answer for a site id, from the due cards or else the deck", async () => {
      const [mcqSite, flashSite] = siteCards();
      const mcq = byKind("mcq");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      remote = fakeRemote({
        answers: {
          get_due_cards: () => ({ deckId: "deck-1", cards: [mcqSite] }),
          get_deck: () => ({ id: "deck-1", cardCount: 2, cards: [mcqSite, flashSite], nextOffset: null }),
        },
      });
      expect(await cli("answer", MCQ_ID)).toEqual({ code: 0, out: { id: MCQ_ID, kind: "mcq", correct: LETTERS[mcq.body.correctChoice], explanation: mcq.body.explanation } });
      expect(remote.calls.map((c) => c.tool)).toEqual(["get_due_cards"]);
      expect(await cli("answer", FLASH_ID)).toEqual({ code: 0, out: { id: FLASH_ID, kind: "flashcard", back: flashSite.definition } });
      expect(callsTo(remote, "get_deck")).toEqual([{ deckId: "deck-1", offset: 0, limit: 200 }]);
      expect(await cli("answer", "44444444-4444-4444-8444-444444444444")).toEqual({ code: 1, out: { error: "no card 44444444-4444-4444-8444-444444444444 in this repository" } });
    });

    it("shows a site id's code from the local card with the plugin's card id", async () => {
      const [mcqSite] = siteCards();
      const plain = { id: "55555555-5555-4555-8555-555555555555", term: "Not a repo card", definition: "y" };
      remote = fakeRemote({ answers: { get_due_cards: () => ({ deckId: "deck-1", cards: [{ ...mcqSite, term: "Edited on the site" }, plain] }) } });
      expect(await cli("show", plain.id)).toMatchObject({ code: 1, out: { error: expect.stringMatching(/no card file/) } });
      const mcq = byKind("mcq");
      const shown = (await cli("show", MCQ_ID)).out as ShowOutput;
      expect(shown).toMatchObject({ id: MCQ_ID, localId: mcq.id, path: "src/ref.ts", startLine: 1, endLine: 5, atHead: { symbolFound: true } });
      expect(shown.atHead.lines).toBe(FILE.split("\n").slice(0, 5).join("\n"));
      // A plugin id, as week prints, is shown from the local file without asking the site.
      const calls = remote.calls.length;
      expect((await cli("show", mcq.id)).out).toMatchObject({ id: mcq.id, path: "src/ref.ts" });
      expect(remote.calls.length).toBe(calls);
    });

    it("records grades on the site by site id, without looking the card up first", async () => {
      expect(await cli("grade", MCQ_ID, "right")).toEqual({ code: 0, out: { id: MCQ_ID, recorded: true, site: SITE, remote: true } });
      await cli("grade", FLASH_ID, "didnt-know");
      await cli("grade", MCQ_ID, "wrong");
      expect(remote.calls.map((c) => c.tool)).toEqual(["record_quiz_results", "record_quiz_results", "record_quiz_results"]);
      expect(callsTo(remote, "record_quiz_results")).toEqual([
        { deckId: "deck-1", outcomes: [{ cardId: MCQ_ID, correct: true }] },
        { deckId: "deck-1", outcomes: [{ cardId: FLASH_ID, correct: false }] },
        { deckId: "deck-1", outcomes: [{ cardId: MCQ_ID, correct: false }] },
      ]);
      expect(remote.calls.every((c) => c.opts?.timeout === 30_000)).toBe(true);
      expect(readJsonl(key, "reviews.jsonl")).toEqual([]);
    });

    it("grades a plugin card id as the site card carrying it", async () => {
      const [mcqSite, flashSite] = siteCards();
      remote = fakeRemote({
        answers: {
          get_due_cards: () => ({ deckId: "deck-1", cards: [mcqSite] }),
          get_deck: () => ({ id: "deck-1", cardCount: 2, cards: [mcqSite, flashSite], nextOffset: null }),
        },
      });
      const flash = byKind("flashcard");
      expect(await cli("grade", flash.id, "right")).toEqual({ code: 0, out: { id: flash.id, recorded: true, site: SITE, remote: true } });
      expect(callsTo(remote, "record_quiz_results")).toEqual([{ deckId: "deck-1", outcomes: [{ cardId: FLASH_ID, correct: true }] }]);
      // A plugin id the site has no card for.
      writeCard(key, { ...flash, id: "late-1" });
      expect(await cli("grade", "late-1", "right")).toEqual({ code: 1, out: { error: "no card late-1 on the site" } });
    });

    it("says so when the site doesn't record the grade", async () => {
      remote = fakeRemote({ unstudied: new Set([MCQ_ID]) });
      expect(await cli("grade", MCQ_ID, "right")).toEqual({
        code: 1, out: { error: `card ${MCQ_ID} isn't studied on the site: it may be a draft or dropped` },
      });
      // Nothing recorded counts the same, even with no id listed as skipped.
      remote = fakeRemote({ answers: { record_quiz_results: () => ({ recorded: 0, correct: 0, skipped: [], streakDays: 0 }) } });
      expect((await cli("grade", MCQ_ID, "right")).code).toBe(1);
    });

    it("keeps stats local", async () => {
      expect((await cli("stats")).out).toMatchObject({ cards: 2, draft: 2 });
      expect(connects).toBe(0);
    });
  });
});

describe("cli with an unlinked repo", () => {
  it("never connects to the site", async () => {
    useTempHome();
    const repo = makeRepo();
    commit(repo, { "src/ref.ts": FILE }, "feat: referral codes");
    const connect = async (): Promise<never> => {
      throw new Error("connected");
    };
    const cli = (...argv: string[]) => main([...argv, "--repo", repo], { now, run, connect });
    await cli("connect");
    await cli("capture", "--since", "1 year ago", "--no-fetch");
    const week = (await cli("week")).out as WeekOutput;
    expect(week).not.toHaveProperty("remote");
    const id = week.areas["src"][0].cards[0].id;
    expect((await cli("curate", id, "keep")).code).toBe(0);
    expect(((await cli("due")).out as DueOutput).due.map((d) => d.id)).toEqual([id]);
    expect((await cli("answer", id)).code).toBe(0);
    expect((await cli("grade", id, "right")).out).toMatchObject({ id, nextDue: expect.any(String) });
  });
});
