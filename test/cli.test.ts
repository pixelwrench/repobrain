import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main, type CurateUnreadable, type DueOutput, type StatsOutput, type WeekOutput } from "../src/cli.js";
import { LETTERS, type Card } from "../src/format.js";
import type { RunClaude } from "../src/generate.js";
import { cardPath, home, listCards, readCard, readJsonl, readState, repoDir, writeCard, writeState } from "../src/store.js";
import { commit, makeRepo, sh, tempDir, useTempHome } from "./helpers.js";

const FILE = ["export function applyReferral(code: string) {", "  const ref = lookup(code);", "  if (!ref) return null;", "  return discount(ref);", "}", ""].join("\n");
const run: RunClaude = async () =>
  JSON.stringify([
    { kind: "mcq", question: "What does applyReferral return for an unknown code?", choices: ["null", "an error", "zero", "the code"], correct: "A", explanation: "It returns null when lookup finds nothing.", path: "src/ref.ts", startLine: 1, endLine: 5, symbol: "applyReferral" },
    { kind: "flashcard", front: "Where are referral codes looked up?", back: "`lookup`, called by `applyReferral`", path: "src/ref.ts", startLine: 2, endLine: 4, symbol: "lookup" },
  ]);
const now = () => new Date("2026-11-02T09:00:00Z");

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
    expect((await cli("week")).out).toEqual({ drafts: 0, flagged: 0, areas: {}, unreadable: [], claudeUnavailable: null, stateError: null });

    const due = (await cli("due")).out as DueOutput;
    expect(due.due.map((d) => d.id)).toEqual([first]);
    expect((await cli("grade", first, "right")).out).toEqual({ id: first, nextDue: "2026-11-05T09:00:00.000Z" });
    expect(((await cli("due")).out as DueOutput).due).toEqual([]);

    expect((await cli("stats")).out).toEqual({
      cards: 2, draft: 0, kept: 1, dropped: 1, changed: 0, orphaned: 0,
      curated: { keep: 1, fix: 0, drop: 1 }, reviews: 1, right: 1, unreadable: [], claudeUnavailable: null, stateError: null,
    } satisfies StatsOutput);
  });

  describe("output shapes", () => {
    const mcqBody = (c: Card) => {
      if (c.body.kind !== "mcq") throw new Error("not mcq");
      return { ...c.body, correct: LETTERS[c.body.correctChoice] };
    };

    it("gives week cards their anchor, and mcq answers as a letter", async () => {
      const key = await connectAndCapture();
      const mcq = byKind(key, "mcq");
      const flash = byKind(key, "flashcard");
      if (mcq.body.kind !== "mcq") throw new Error("not mcq");
      expect(mcq.body.choices[mcq.body.correctChoice]).toBe("null");
      const cards = ((await cli("week")).out as WeekOutput).areas["src"][0].cards;
      expect(cards.find((c) => c.id === mcq.id)).toEqual({
        id: mcq.id, status: "draft", anchor: "fresh", path: "src/ref.ts", symbol: "applyReferral",
        body: {
          kind: "mcq", question: "What does applyReferral return for an unknown code?", choices: mcq.body.choices,
          correctChoice: mcq.body.correctChoice, correct: LETTERS[mcq.body.correctChoice], explanation: "It returns null when lookup finds nothing.",
        },
      });
      expect(cards.find((c) => c.id === flash.id)).toEqual({
        id: flash.id, status: "draft", anchor: "fresh", path: "src/ref.ts", symbol: "lookup",
        body: { kind: "flashcard", front: "Where are referral codes looked up?", back: "`lookup`, called by `applyReferral`" },
      });
    });

    it("gives due cards their area and whether their code changed", async () => {
      const key = await connectAndCapture();
      const mcq = keep(key, byKind(key, "mcq"), { status: "changed" });
      const flash = keep(key, byKind(key, "flashcard"));
      const due = ((await cli("due")).out as DueOutput).due;
      expect(due.find((d) => d.id === mcq.id)).toEqual({ id: mcq.id, area: "src", path: "src/ref.ts", codeChanged: true, body: mcqBody(mcq) });
      expect(due.find((d) => d.id === flash.id)).toEqual({
        id: flash.id, area: "src", path: "src/ref.ts", codeChanged: false,
        body: { kind: "flashcard", front: "Where are referral codes looked up?", back: "`lookup`, called by `applyReferral`" },
      });
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
      expect(await cli("curate", card.id, "keep")).toEqual({ code: 1, out: { error: `can't re-anchor ${card.id}: fix the card or drop it` } });
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
      expect(await cli("curate", card.id, "fix")).toEqual({ code: 1, out: { error: `can't re-anchor ${card.id}: fix the card or drop it` } });
      expect(fs.readFileSync(cardPath(key, card.id), "utf8")).toBe(before);
      expect(readJsonl(key, "curation.jsonl")).toEqual([]);
    });

    it("refuses to keep or fix an orphaned card, but lets it be dropped", async () => {
      const key = await connectAndCapture();
      const card = keep(key, byKind(key, "mcq"), { status: "orphaned" });
      for (const decision of ["keep", "fix"]) {
        expect(await cli("curate", card.id, decision)).toEqual({ code: 1, out: { error: `the code for ${card.id} was removed; drop it or fix its anchor` } });
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
    const wt = path.join(tempDir("codebrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const week = await main(["week", "--repo", wt], { now, run });
    expect(week.code).toBe(0);
    expect((week.out as WeekOutput).drafts).toBe(2);
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
    expect(await cli("due")).toEqual({ code: 1, out: { error: expect.stringMatching(/codebrain connect/) } });
  });

  it("returns errors instead of throwing", async () => {
    await cli("connect");
    fs.writeFileSync(path.join(home(), "config.json"), "{not json");
    for (const cmd of ["week", "due", "stats", "connect"]) {
      expect(await cli(cmd)).toEqual({ code: 1, out: { error: expect.stringMatching(/not valid JSON/) } });
    }
  });

  it("logs a capture in an unconnected repo to capture-errors.log", async () => {
    expect(await cli("capture", "--no-fetch")).toEqual({ code: 1, out: { error: expect.stringMatching(/codebrain connect/) } });
    const log = fs.readFileSync(path.join(home(), "capture-errors.log"), "utf8");
    expect(log).toContain(repo);
    expect(log).toMatch(/codebrain connect/);
  });

  it("logs a capture outside any git repository to capture-errors.log", async () => {
    const dir = tempDir("codebrain-nogit-");
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

describe("the codebrain binary", () => {
  let bin: string;
  beforeAll(() => {
    // Build to a temp dir, with this repo's node_modules linked in so ts-fsrs resolves.
    const out = tempDir("codebrain-bin-");
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
    expect(unconnected).toMatchObject({ code: 1, out: { error: expect.stringMatching(/codebrain connect/) } });
    expect(unconnected.stderr).not.toMatch(/\n\s+at /);

    expect(spawn(["connect", "--repo", repo])).toMatchObject({ code: 0, out: { connected: expect.any(String) } });
    expect(spawn(["stats", "--repo", repo])).toMatchObject({ code: 0, out: { cards: 0 } });
    const bad = spawn(["grade", "../x", "right", "--repo", repo]);
    expect(bad).toMatchObject({ code: 2, out: { error: 'invalid card id "../x"' } });
    expect(bad.stderr).toBe("");
  });
});
