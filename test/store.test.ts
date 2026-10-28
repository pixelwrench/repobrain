import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { serializeCard, type Card } from "../src/format.js";
import { acquireLock, appendJsonl, connectRepo, findRepo, listCards, readCard, readJsonl, readState, writeCard, writeState } from "../src/store.js";
import { commit, makeRepo, useTempHome } from "./helpers.js";

const card = (id: string): Card => ({
  id, repo: "r", merge: "m".repeat(40), mergeTitle: "t", area: "src", createdAt: "2026-11-02T09:00:00.000Z", status: "draft",
  anchor: { commit: "c", path: "src/a.ts", symbol: null, startLine: 1, endLine: 2, lines: 2, fingerprint: "f", status: "fresh" },
  body: { kind: "flashcard", front: "front", back: "back" },
});

describe("store", () => {
  let repo: string;
  beforeEach(() => {
    useTempHome();
    repo = makeRepo();
    commit(repo, { "src/a.ts": "export const a = 1;\n" }, "first");
  });

  it("connects a repo and finds it from a subdirectory", () => {
    const key = connectRepo(repo);
    expect(findRepo(path.join(repo, "src"))?.key).toBe(key);
  });

  it("returns null for a repo that isn't connected", () => {
    expect(findRepo(repo)).toBeNull();
  });

  it("writes, reads and lists cards, skipping malformed files", () => {
    const key = connectRepo(repo);
    writeCard(key, card("one"));
    writeCard(key, card("two"));
    fs.writeFileSync(path.join(process.env.CODEBRAIN_HOME!, "repos", key, "cards", "bad.md"), "nonsense");
    expect(readCard(key, "one")).toEqual(card("one"));
    expect(listCards(key).map((c) => c.id)).toEqual(["one", "two"]);
    expect(serializeCard(card("one"))).toContain("Front: front");
  });

  it("keeps per-repo state", () => {
    const key = connectRepo(repo);
    expect(readState(key).lastSha).toBeNull();
    writeState(key, { lastSha: "abc", updatedAt: "2026-11-02T09:00:00.000Z" });
    expect(readState(key).lastSha).toBe("abc");
  });

  it("locks against a second capture and reclaims a stale lock", () => {
    const key = connectRepo(repo);
    const release = acquireLock(key);
    expect(release).toBeTypeOf("function");
    expect(acquireLock(key)).toBeNull();
    expect(acquireLock(key, 0)).toBeTypeOf("function");
  });

  it("appends and reads JSON lines", () => {
    const key = connectRepo(repo);
    appendJsonl(key, "reviews.jsonl", { a: 1 });
    appendJsonl(key, "reviews.jsonl", { a: 2 });
    expect(readJsonl(key, "reviews.jsonl")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(readJsonl(key, "missing.jsonl")).toEqual([]);
  });
});
