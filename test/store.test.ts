import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCard, type Card } from "../src/format.js";
import {
  acquireLock,
  appendJsonl,
  cardPath,
  connectRepo,
  findRepo,
  listCards,
  listCardsReport,
  loadConfig,
  readCard,
  readJsonl,
  readState,
  repoDir,
  writeCard,
  writeFileAtomic,
  writeState,
} from "../src/store.js";
import { commit, makeRepo, sh, tempDir, useTempHome } from "./helpers.js";

const card = (id: string): Card => ({
  id, repo: "r", merge: "m".repeat(40), mergeTitle: "t", area: "src", createdAt: "2026-11-02T09:00:00.000Z", status: "draft", source: "merge",
  anchor: { commit: "c", path: "src/a.ts", symbol: null, startLine: 1, endLine: 2, lines: 2, fingerprint: "f", status: "fresh" },
  body: { kind: "flashcard", front: "front", back: "back" },
});

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid!;
}

describe("store", () => {
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = useTempHome();
    repo = makeRepo();
    commit(repo, { "src/a.ts": "export const a = 1;\n" }, "first");
  });

  it("connects a repo and finds it from a subdirectory", () => {
    const key = connectRepo(repo);
    expect(findRepo(path.join(repo, "src"))?.key).toBe(key);
  });

  it("finds the connected main repo from a linked worktree", () => {
    const key = connectRepo(repo);
    const inside = path.join(repo, ".worktrees", "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", inside]);
    const elsewhere = path.join(tempDir("repobrain-wt-"), "other");
    sh(repo, ["worktree", "add", "-q", "-b", "other", elsewhere]);
    expect(findRepo(inside)).toEqual({ key, config: { path: repo, areaDepth: 3 } });
    expect(findRepo(elsewhere)?.key).toBe(key);
  });

  it("connects the main repo when run from a linked worktree", () => {
    const wt = path.join(tempDir("repobrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const key = connectRepo(path.join(wt, "src"));
    expect(key).toBe(connectRepo(repo));
    expect(loadConfig().repos).toEqual({ [key]: { path: repo, areaDepth: 3 } });
  });

  it("returns null for a repo that isn't connected", () => {
    expect(findRepo(repo)).toBeNull();
  });

  it("writes, reads and lists cards, skipping malformed and temp files", () => {
    const key = connectRepo(repo);
    writeCard(key, card("one"));
    writeCard(key, card("two"));
    const cards = path.join(home, "repos", key, "cards");
    fs.writeFileSync(path.join(cards, "bad.md"), "nonsense");
    fs.writeFileSync(path.join(cards, "three.md.123.abc.tmp"), serializeCard(card("three")));
    expect(fs.readFileSync(path.join(cards, "one.md"), "utf8")).toBe(serializeCard(card("one")));
    expect(readCard(key, "one")).toEqual(card("one"));
    expect(listCards(key).map((c) => c.id)).toEqual(["one", "two"]);
  });

  it("leaves no temp files after writes", () => {
    const key = connectRepo(repo);
    writeCard(key, card("one"));
    writeState(key, { lastSha: "abc", updatedAt: null });
    const file = path.join(home, "x.txt");
    writeFileAtomic(file, "hi");
    expect(fs.readFileSync(file, "utf8")).toBe("hi");
    const all = fs.readdirSync(home, { recursive: true }).map(String);
    expect(all.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unsafe card ids and repo keys", () => {
    const key = connectRepo(repo);
    for (const id of ["../x", "a/b", "", ".hidden", "a b"]) expect(() => cardPath(key, id)).toThrow();
    expect(() => writeCard(key, card("../escape"))).toThrow();
    expect(() => repoDir("../other")).toThrow();
    expect(cardPath(key, "ok-1.2_x")).toMatch(/ok-1\.2_x\.md$/);
  });

  it("lists only cards whose id is safe and matches the file name", () => {
    const key = connectRepo(repo);
    writeCard(key, card("one"));
    const cards = path.join(home, "repos", key, "cards");
    fs.writeFileSync(path.join(cards, "other.md"), serializeCard(card("two")));
    fs.writeFileSync(path.join(cards, "evil.md"), serializeCard(card("../evil")));
    expect(listCards(key).map((c) => c.id)).toEqual(["one"]);
  });

  it("reports unreadable card files alongside the readable ones", () => {
    const key = connectRepo(repo);
    writeCard(key, card("one"));
    const cards = path.join(home, "repos", key, "cards");
    fs.writeFileSync(path.join(cards, "broken.md"), "no front matter\n");
    fs.writeFileSync(path.join(cards, "other.md"), serializeCard(card("two")));
    const report = listCardsReport(key);
    expect(report.cards.map((c) => c.id)).toEqual(["one"]);
    expect(report.unreadable).toEqual([
      { file: path.join(cards, "broken.md"), error: "missing front matter" },
      { file: path.join(cards, "other.md"), error: 'card id "two" is unsafe or doesn\'t match its file name' },
    ]);
  });

  it("throws when a card file's id doesn't match its name", () => {
    const key = connectRepo(repo);
    fs.writeFileSync(cardPath(key, "other"), serializeCard(card("one")));
    expect(() => readCard(key, "other")).toThrow();
  });

  it("keeps per-repo state", () => {
    const key = connectRepo(repo);
    expect(readState(key).lastSha).toBeNull();
    writeState(key, { lastSha: "abc", updatedAt: "2026-11-02T09:00:00.000Z" });
    expect(readState(key).lastSha).toBe("abc");
  });

  it("fails loudly on a corrupt config.json and leaves it unchanged", () => {
    const file = path.join(home, "config.json");
    fs.writeFileSync(file, "{not json");
    expect(() => connectRepo(repo)).toThrow(/config\.json is not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe("{not json");
    fs.writeFileSync(file, "[1]");
    expect(() => connectRepo(repo)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("[1]");
  });

  it("fails loudly on a corrupt state.json", () => {
    const key = connectRepo(repo);
    fs.writeFileSync(path.join(home, "repos", key, "state.json"), "garbage");
    expect(() => readState(key)).toThrow(/state\.json is not valid JSON/);
  });

  describe("lock", () => {
    let key: string;
    let lockFile: string;
    beforeEach(() => {
      key = connectRepo(repo);
      lockFile = path.join(home, "repos", key, "capture.lock");
    });

    it("is exclusive while held and can be re-acquired after release", () => {
      const lock = acquireLock(key);
      expect(lock).not.toBeNull();
      expect(acquireLock(key)).toBeNull();
      lock!.release();
      expect(fs.existsSync(lockFile)).toBe(false);
      const again = acquireLock(key);
      expect(again).not.toBeNull();
      again!.release();
    });

    it("returns null for a lock held by a live pid within staleMs", () => {
      fs.writeFileSync(lockFile, `${process.pid}:someone-else`);
      expect(acquireLock(key)).toBeNull();
      expect(fs.readFileSync(lockFile, "utf8")).toBe(`${process.pid}:someone-else`);
    });

    it("reclaims a fresh lock whose holder pid is dead", () => {
      fs.writeFileSync(lockFile, `${deadPid()}:gone`);
      const lock = acquireLock(key);
      expect(lock).not.toBeNull();
      expect(fs.readFileSync(lockFile, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      expect(fs.readdirSync(path.dirname(lockFile)).filter((f) => f.includes(".stale"))).toEqual([]);
      lock!.release();
    });

    it("doesn't let a stale holder release or refresh the reclaimer's lock", () => {
      const old = acquireLock(key)!;
      const reclaimer = acquireLock(key, 0)!;
      expect(reclaimer).not.toBeNull();
      const token = fs.readFileSync(lockFile, "utf8");
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lockFile, past, past);
      old.release();
      old.refresh();
      expect(fs.readFileSync(lockFile, "utf8")).toBe(token);
      expect(fs.statSync(lockFile).mtimeMs).toBeCloseTo(past.getTime(), -3);
      reclaimer.release();
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    it("refresh ignores a lock file that vanishes mid-refresh", () => {
      const lock = acquireLock(key)!;
      const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
      const spy = vi.spyOn(fs, "utimesSync").mockImplementation(() => {
        throw enoent;
      });
      try {
        expect(() => lock.refresh()).not.toThrow();
      } finally {
        spy.mockRestore();
      }
      lock.release();
    });

    it("refresh touches the lock's mtime", () => {
      const lock = acquireLock(key)!;
      const past = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(lockFile, past, past);
      lock.refresh();
      expect(Date.now() - fs.statSync(lockFile).mtimeMs).toBeLessThan(10_000);
      lock.release();
    });
  });

  it("appends and reads JSON lines, skipping corrupt ones", () => {
    const key = connectRepo(repo);
    appendJsonl(key, "reviews.jsonl", { a: 1 });
    fs.appendFileSync(path.join(home, "repos", key, "reviews.jsonl"), "{half\n");
    appendJsonl(key, "reviews.jsonl", { a: 2 });
    expect(readJsonl(key, "reviews.jsonl")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(readJsonl(key, "missing.jsonl")).toEqual([]);
  });
});
