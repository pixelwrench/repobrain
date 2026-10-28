import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Card } from "../src/format.js";
import { dueCards, loadSchedule, nextState, recordGrade } from "../src/schedule.js";
import { connectRepo, readJsonl, repoDir } from "../src/store.js";
import { commit, makeRepo, useTempHome } from "./helpers.js";

const t0 = new Date("2026-11-02T09:00:00Z");

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id, repo: "r", merge: "m", mergeTitle: "t", area: "src", createdAt: t0.toISOString(), status: "kept",
  anchor: { commit: "c", path: "src/a.ts", symbol: null, startLine: 1, endLine: 1, lines: 1, fingerprint: "f", status: "fresh" },
  body: { kind: "flashcard", front: "f", back: "b" },
  ...over,
});

describe("nextState (FSRS-6, day intervals)", () => {
  it("schedules a new card answered right three days out", () => {
    expect(nextState(undefined, "right", t0).due.toISOString()).toBe("2026-11-05T09:00:00.000Z");
  });
  it("grows the interval on a second right answer", () => {
    const a = nextState(undefined, "right", t0);
    expect(nextState(a, "right", a.due).due.toISOString()).toBe("2026-11-19T09:00:00.000Z");
  });
  it("shortens the interval after a wrong answer", () => {
    const a = nextState(undefined, "right", t0);
    const b = nextState(a, "right", a.due);
    expect(nextState(b, "wrong", b.due).due.toISOString()).toBe("2026-11-21T09:00:00.000Z");
  });
  it("treats didnt-know like wrong", () => {
    expect(nextState(undefined, "didnt-know", t0).due.toISOString()).toBe("2026-11-03T09:00:00.000Z");
  });
});

describe("dueCards and recordGrade", () => {
  beforeEach(() => useTempHome());

  it("lists new and due kept cards, never drafts, dropped or orphaned ones", () => {
    const cards = [
      card("new"),
      card("draft", { status: "draft" }),
      card("dropped", { status: "dropped" }),
      card("orphan", { anchor: { ...card("x").anchor, status: "orphaned" } }),
      card("later"),
    ];
    const sched = { later: nextState(undefined, "right", t0) };
    expect(dueCards(cards, sched, t0).map((c) => c.id)).toEqual(["new"]);
  });

  it("persists grades and logs reviews", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    const key = connectRepo(repo);
    recordGrade(key, "one", "right", t0);
    expect(loadSchedule(key).one.due.toISOString()).toBe("2026-11-05T09:00:00.000Z");
    expect(readJsonl(key, "reviews.jsonl")).toEqual([{ card: "one", grade: "right", at: t0.toISOString(), due: "2026-11-05T09:00:00.000Z" }]);
  });

  it("starts empty without a schedule file but refuses a corrupt one", () => {
    const repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    const key = connectRepo(repo);
    expect(loadSchedule(key)).toEqual({});
    fs.writeFileSync(path.join(repoDir(key), "schedule.json"), "{not json");
    expect(() => loadSchedule(key)).toThrow(/schedule\.json is not valid JSON/);
    expect(() => recordGrade(key, "one", "right", t0)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(path.join(repoDir(key), "schedule.json"), "utf8")).toBe("{not json");
  });
});
