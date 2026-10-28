import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { RunClaude } from "../src/generate.js";
import { home, listCards, readCard, readJsonl, repoDir, writeCard } from "../src/store.js";
import { commit, makeRepo, tempDir, useTempHome } from "./helpers.js";

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
    const key = (await cli("connect")).out as { connected: string };
    await cli("capture", "--since", "1 year ago", "--no-fetch");
    return key.connected;
  };

  it("connects, captures, curates, reviews and reports stats", async () => {
    expect((await cli("connect")).code).toBe(0);
    const cap = await cli("capture", "--since", "1 year ago", "--no-fetch");
    expect(cap).toMatchObject({ code: 0, out: { status: "done", cardsWritten: 2 } });

    const week = (await cli("week")).out as { drafts: number; flagged: number; areas: Record<string, { merge: string; title: string; cards: { id: string }[] }[]> };
    expect(week).toMatchObject({ drafts: 2, flagged: 0 });
    expect(week.areas["src"][0].title).toBe("feat: referral codes");
    const [first, second] = week.areas["src"][0].cards.map((c) => c.id);

    expect((await cli("curate", first, "keep")).out).toMatchObject({ id: first, status: "kept" });
    expect((await cli("curate", second, "drop")).out).toMatchObject({ id: second, status: "dropped" });
    expect((await cli("week")).out).toMatchObject({ drafts: 0, flagged: 0, areas: {} });

    const due = (await cli("due")).out as { due: { id: string; codeChanged: boolean }[] };
    expect(due.due.map((d) => d.id)).toEqual([first]);
    expect(due.due[0].codeChanged).toBe(false);
    expect((await cli("grade", first, "right")).out).toMatchObject({ id: first, nextDue: "2026-11-05T09:00:00.000Z" });
    expect(((await cli("due")).out as { due: unknown[] }).due).toEqual([]);

    expect((await cli("stats")).out).toEqual({
      cards: 2, draft: 0, kept: 1, dropped: 1, changed: 0, orphaned: 0,
      curated: { keep: 1, fix: 0, drop: 1 }, reviews: 1, right: 1,
    });
  });

  it("records fix as kept, and logs the decision", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect((await cli("curate", card.id, "fix")).out).toEqual({ id: card.id, status: "kept" });
    expect(readCard(key, card.id).status).toBe("kept");
    expect(readJsonl(key, "curation.jsonl")).toEqual([{ card: card.id, decision: "fix", at: "2026-11-02T09:00:00.000Z" }]);
  });

  it("flags kept cards whose code changed in week", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    writeCard(key, { ...card, status: "kept", anchor: { ...card.anchor, status: "changed" } });
    const week = (await cli("week")).out as { drafts: number; flagged: number; areas: Record<string, { cards: { id: string; anchor: string }[] }[]> };
    expect(week).toMatchObject({ drafts: 1, flagged: 1 });
    expect(week.areas["src"][0].cards.find((c) => c.id === card.id)?.anchor).toBe("changed");
  });

  it("limits due cards", async () => {
    const key = await connectAndCapture();
    for (const c of listCards(key)) await cli("curate", c.id, "keep");
    expect(((await cli("due", "--limit", "1")).out as { due: unknown[] }).due).toHaveLength(1);
    expect((await cli("due", "--limit", "0")).code).toBe(2);
  });

  it("returns a card's file path", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect((await cli("card", card.id)).out).toEqual({ path: path.join(repoDir(key), "cards", `${card.id}.md`) });
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
    expect(fs.existsSync(path.join(home(), "config.json"))).toBe(true);
  });

  it("only grades kept cards", async () => {
    const key = await connectAndCapture();
    const [card] = listCards(key);
    expect(await cli("grade", card.id, "right")).toMatchObject({ code: 1, out: { error: expect.stringMatching(/draft/) } });
    expect(readJsonl(key, "reviews.jsonl")).toEqual([]);
  });

  it("explains how to connect an unconnected repo", async () => {
    await expect(cli("due")).rejects.toThrow(/codebrain connect/);
  });

  it("logs a capture in an unconnected repo to capture-errors.log", async () => {
    await expect(cli("capture", "--no-fetch")).rejects.toThrow(/codebrain connect/);
    const log = fs.readFileSync(path.join(home(), "capture-errors.log"), "utf8");
    expect(log).toContain(repo);
    expect(log).toMatch(/codebrain connect/);
  });

  it("logs a capture outside any git repository to capture-errors.log", async () => {
    const dir = tempDir("codebrain-nogit-");
    await expect(main(["capture", "--repo", dir], { now, run })).rejects.toThrow();
    expect(fs.readFileSync(path.join(home(), "capture-errors.log"), "utf8")).toContain(dir);
  });

  it("logs a failed capture to the repo's capture.log exactly once", async () => {
    const key = (await cli("connect")).out as { connected: string };
    fs.writeFileSync(path.join(repoDir(key.connected), "state.json"), "{not json");
    await expect(cli("capture", "--no-fetch")).rejects.toThrow(/not valid JSON/);
    const log = fs.readFileSync(path.join(repoDir(key.connected), "capture.log"), "utf8");
    expect(log.match(/not valid JSON/g)).toHaveLength(1);
    expect(fs.existsSync(path.join(home(), "capture-errors.log"))).toBe(false);
  });

  it("logs bad capture arguments to the repo's capture.log", async () => {
    const key = (await cli("connect")).out as { connected: string };
    expect((await cli("capture", "--max", "0")).code).toBe(2);
    expect(fs.readFileSync(path.join(repoDir(key.connected), "capture.log"), "utf8")).toMatch(/--max/);
  });
});
