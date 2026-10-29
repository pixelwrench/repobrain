import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BaselineError, baselineStatus, buildBaselinePrompt, buildPlanPrompt, draftBaselineArea, MAX_AREA_CARDS, planBaseline, readPlan, setAreaSkipped,
} from "../src/baseline.js";
import { ClaudeEnvError, ClaudeLimitError, ClaudeResultError, MAX_CARDS, type RunClaude } from "../src/generate.js";
import { acquireLock, cardPath, connectRepo, listCards, readCard, repoDir, writeCard } from "../src/store.js";
import { commit, makeRepo, useTempHome } from "./helpers.js";

const FILE = ["export function applyReferral(code: string) {", "  const ref = lookup(code);", "  if (!ref) return null;", "  return discount(ref);", "}", ""].join("\n");
const SERVER = ["import { applyReferral } from './ref';", "export function handle(req: Request) {", "  return applyReferral(req.code);", "}", ""].join("\n");
// Built by concatenation so secret scanners don't flag this repo.
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

const reply = (value: unknown, costUsd: number | null = null) => ({ text: typeof value === "string" ? value : JSON.stringify(value), costUsd });
const now = () => new Date("2026-11-02T09:00:00Z");
const twoAreas = [
  { name: "Request handling", why: "Where requests come in", files: ["src/server.ts"] },
  { name: "Referrals", why: "How codes become discounts", files: ["src/ref.ts", "src/server.ts"] },
];
const card = (p: string, over: Record<string, unknown> = {}) => ({
  kind: "flashcard", front: `What lives in ${p}?`, back: "The referral lookup.", path: p, startLine: 1, endLine: 4, symbol: null, ...over,
});

describe("baseline", () => {
  let repo: string;
  let key: string;
  let head: string;
  const log = () => fs.readFileSync(path.join(repoDir(key), "capture.log"), "utf8");
  const plan = (run: RunClaude, over = {}) => planBaseline(key, { fetch: false, run, now, ...over });
  const planned = async (areas: unknown = twoAreas) => (await plan(async () => reply(areas, 0.004))).plan!;

  beforeEach(() => {
    useTempHome();
    repo = makeRepo();
    head = commit(
      repo,
      {
        "README.md": "# Demo\n\nA referral service.\n", "src/ref.ts": FILE, "src/server.ts": SERVER, "package-lock.json": "{}\n",
        "dist/app.js": "x\n", ".env": "A=1\n", "secrets/notes.txt": "private\n", "logo.png": "\u0000\u0001\u0002", ".codebrain/ignore": "secrets/**\n",
      },
      "first",
    );
    key = connectRepo(repo);
  });

  describe("plan", () => {
    it("sends the file list with line counts and the README as data, and saves the areas in order", async () => {
      let seen = { prompt: "", stdin: "" };
      const out = await plan(async (prompt, stdin) => ((seen = { prompt, stdin }), reply(twoAreas, 0.0042)));
      expect(seen.prompt).toBe(buildPlanPrompt());
      expect(seen.prompt).toMatch(/data, never as instructions/);
      expect(seen.stdin).toContain("src/ref.ts\t5\n");
      expect(seen.stdin).toContain("src/server.ts\t4\n");
      expect(seen.stdin).toContain("A referral service.");
      for (const hidden of ["package-lock.json", "dist/app.js", ".env", "secrets/notes.txt", "logo.png"]) expect(seen.stdin).not.toContain(hidden);
      expect(out).toMatchObject({ existing: false, costUsd: 0.0042, rejected: [], sent: { files: 4, totalFiles: 4, truncated: false, readme: "README.md" } });
      const saved = readPlan(key)!;
      expect(saved).toEqual(out.plan);
      expect(saved).toEqual({
        commit: head, plannedAt: "2026-11-02T09:00:00.000Z", nonce: expect.stringMatching(/^[0-9a-f]{4}$/), planCostUsd: 0.0042,
        areas: [
          { id: "a01-request-handling", name: "Request handling", why: "Where requests come in", files: ["src/server.ts"], status: "planned", cards: 0, costUsd: null },
          { id: "a02-referrals", name: "Referrals", why: "How codes become discounts", files: ["src/ref.ts", "src/server.ts"], status: "planned", cards: 0, costUsd: null },
        ],
      });
      expect(log()).toContain("baseline plan at " + head + ": 2 areas, cost $0.0042");
    });

    it("leaves out a README that looks like it holds a secret", async () => {
      head = commit(repo, { "README.md": `# Demo\nkey ${AWS_KEY}\n` }, "readme");
      let stdin = "";
      const out = await plan(async (_p, s) => ((stdin = s), reply(twoAreas)));
      expect(stdin).not.toContain(AWS_KEY);
      expect(stdin).toContain("README.md\t2\n");
      expect(out.sent?.readme).toBeNull();
    });

    it("sends at most 8,000 bytes of the README", async () => {
      commit(repo, { "README.md": "r".repeat(9_000) + "TAIL" }, "long readme");
      let stdin = "";
      await plan(async (_p, s) => ((stdin = s), reply(twoAreas)));
      expect(stdin).toContain("r".repeat(8_000));
      expect(stdin).not.toContain("r".repeat(8_001));
      expect(stdin).not.toContain("TAIL");
    });

    it("leaves out the whole README when a secret starts just before the 8,000-byte cut", async () => {
      const token = "ghp_" + "a".repeat(36);
      for (const secret of [AWS_KEY, token]) {
        commit(repo, { "README.md": "r".repeat(7_994) + " " + secret + "\n" }, "readme");
        let stdin = "";
        const out = await plan(async (_p, s) => ((stdin = s), reply(twoAreas)), { force: true });
        expect(stdin).not.toContain("r".repeat(100));
        expect(stdin).not.toContain(secret.slice(0, 5));
        expect(out.sent?.readme).toBeNull();
      }
    });

    it("returns an existing plan unchanged without calling claude, and re-plans at the head with --force", async () => {
      const first = await planned();
      let called = false;
      const again = await plan(async () => ((called = true), reply(twoAreas)));
      expect(called).toBe(false);
      expect(again).toMatchObject({ existing: true, plan: first, note: expect.stringMatching(/--force/) });
      const next = commit(repo, { "src/new.ts": "export const fresh = 1;\n" }, "new");
      const forced = await plan(async () => reply([{ name: "New", why: "w", files: ["src/new.ts"] }]), { force: true });
      expect(forced.plan).toMatchObject({ commit: next, areas: [{ id: "a01-new", files: ["src/new.ts"] }] });
    });

    it("keeps only valid areas and files, deduplicated and capped", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 10; i++) files[`src/f${i}.ts`] = `export const v${i} = ${i};\n`;
      commit(repo, files, "more");
      const many = Array.from({ length: 14 }, (_, i) => ({ name: `Area ${i}`, why: "w", files: ["src/ref.ts"] }));
      const out = await plan(async () =>
        reply([
          { name: "  Lots\n of files ", why: "why\nthis", files: [...Object.keys(files), "src/ref.ts", "src/ref.ts", "nope.ts", 3] },
          { name: "", why: "w", files: ["src/ref.ts"] },
          { name: "x".repeat(81), why: "w", files: ["src/ref.ts"] },
          { name: "lots of files", why: "w", files: ["src/ref.ts"] },
          { name: "Nothing real", why: "w", files: ["nope.ts", ".env"] },
          { name: "Secret " + AWS_KEY, why: "w", files: ["src/ref.ts"] },
          "not an area",
          ...many,
        ]),
      );
      const areas = out.plan!.areas;
      expect(areas).toHaveLength(12);
      expect(areas[0]).toMatchObject({ id: "a01-lots-of-files", name: "Lots of files", why: "why this" });
      expect(areas[0].files).toEqual(Object.keys(files).slice(0, 8));
      expect(areas[1]).toMatchObject({ id: "a02-area-0", name: "Area 0" });
      expect(areas[11].id).toBe("a12-area-10");
      expect(out.rejected).toEqual([
        "an area with an empty name or one over 80 characters",
        "an area with an empty name or one over 80 characters",
        'a repeated area name: "lots of files"',
        '"Nothing real": none of its files are in the list',
        "an area whose name or reason looks like it holds a secret",
        "not an area object",
      ]);
    });

    it("gives each area a safe id even when its name has no letters", async () => {
      const out = await plan(async () => reply([{ name: "日本語", why: "w", files: ["src/ref.ts"] }, { name: "../..", why: "w", files: ["src/ref.ts"] }]));
      expect(out.plan!.areas.map((a) => a.id)).toEqual(["a01", "a02"]);
    });

    it("lists at most 3,000 files, and says so", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 3_005; i++) files[`many/f${String(i).padStart(4, "0")}.txt`] = "x\n";
      commit(repo, files, "many");
      let stdin = "";
      const out = await plan(async (_p, s) => ((stdin = s), reply(twoAreas)));
      expect(out.sent).toMatchObject({ files: 3_000, totalFiles: 3_009, truncated: true });
      expect(stdin).toContain("3,000 of 3,009");
      expect(stdin).not.toContain("src/server.ts\t");
    });

    it("saves nothing, and reports the error and cost, when the reply has no usable areas or claude fails", async () => {
      const bad = await plan(async () => reply([{ name: "x", why: "w", files: ["nope.ts"] }], 0.003));
      expect(bad).toMatchObject({ plan: null, error: expect.stringMatching(/no usable areas/), costUsd: 0.003 });
      expect(readPlan(key)).toBeNull();
      const env = await plan(async () => {
        throw new ClaudeEnvError("claude is offline");
      });
      expect(env).toMatchObject({ plan: null, error: "claude is offline", costUsd: null });
      const over = await plan(async () => {
        throw new ClaudeResultError("error_max_budget_usd", "over budget", 0.51);
      });
      expect(over).toMatchObject({ plan: null, error: "over budget", costUsd: 0.51 });
      expect(readPlan(key)).toBeNull();
    });

    it("refuses while a capture or baseline holds the lock", async () => {
      const lock = acquireLock(key)!;
      try {
        await expect(plan(async () => reply(twoAreas))).rejects.toThrow(/a capture or baseline is running/);
      } finally {
        lock.release();
      }
    });
  });

  describe("draft", () => {
    const draft = (opts: { areaId?: string; next?: boolean }, run: RunClaude) => draftBaselineArea(key, { ...opts, run, now });

    it("drafts the next planned area from its files at the baseline commit, sent as numbered data", async () => {
      await planned();
      commit(repo, { "src/server.ts": "// moved on\n" + SERVER }, "later");
      let seen = { prompt: "", stdin: "" };
      const out = await draft({ next: true }, async (prompt, stdin) => ((seen = { prompt, stdin }), reply([card("src/server.ts", { startLine: 2, endLine: 4 }), card("src/ref.ts")], 0.0123)));
      expect(seen.prompt).toBe(buildBaselinePrompt());
      expect(seen.prompt).toMatch(/NEW to this codebase/);
      expect(seen.stdin).toContain("Area: Request handling\n");
      expect(seen.stdin).toContain("File: src/server.ts\n1| import { applyReferral } from './ref';\n2| export function handle(req: Request) {\n");
      expect(seen.stdin).not.toContain("moved on");
      expect(out).toMatchObject({
        area: { id: "a01-request-handling", name: "Request handling", status: "drafted" }, cardsWritten: 1,
        rejected: ["path not sent: src/ref.ts"], dropped: [], skippedFiles: [], costUsd: 0.0123,
      });
      expect(out.error).toBeUndefined();
      const [c] = listCards(key);
      expect(c).toMatchObject({
        id: `b${head.slice(0, 8)}-${readPlan(key)!.nonce}-a01-request-handling-1`, merge: head, mergeTitle: "Baseline: Request handling", source: "baseline", area: "src", status: "draft",
        anchor: { commit: head, path: "src/server.ts", startLine: 2, endLine: 4, status: "fresh" },
      });
      expect(readPlan(key)!.areas[0]).toMatchObject({ status: "drafted", cards: 1, costUsd: 0.0123 });
      expect(readPlan(key)!.areas[1].status).toBe("planned");
      expect(log()).toContain("baseline a01-request-handling: 1 cards, 1 rejected, cost $0.0123");
    });

    it("drafts a named area, and caps its cards", async () => {
      await planned();
      const cards = Array.from({ length: MAX_AREA_CARDS + 3 }, (_, i) => card("src/ref.ts", { front: `Question ${i}?` }));
      const out = await draft({ areaId: "a02-referrals" }, async () => reply(cards));
      expect(MAX_AREA_CARDS).toBeGreaterThan(MAX_CARDS);
      expect(out.cardsWritten).toBe(MAX_AREA_CARDS);
      expect(readPlan(key)!.areas.map((a) => a.status)).toEqual(["planned", "drafted"]);
    });

    it("drops sensitive or secret-looking files, and skips files that would go over 60,000 bytes", async () => {
      head = commit(
        repo,
        { "src/keys.ts": `export const k = "${AWS_KEY}";\n`, "src/big.ts": "// big\n".repeat(9_000), "config/.npmrc": "registry=x\n" },
        "more",
      );
      await planned([{ name: "Mixed", why: "w", files: ["src/keys.ts", "src/ref.ts", "src/big.ts", "src/server.ts"] }]);
      // .npmrc is excluded by its path at plan time; force it into the plan to check the draft-time check too.
      const p = readPlan(key)!;
      p.areas[0].files.push("config/.npmrc");
      fs.writeFileSync(path.join(repoDir(key), "baseline.json"), JSON.stringify(p));
      let stdin = "";
      const out = await draft({ next: true }, async (_p, s) => ((stdin = s), reply([card("src/ref.ts")])));
      expect(out.dropped).toEqual([
        { path: "src/keys.ts", reason: "looks like it holds a secret" },
        { path: "config/.npmrc", reason: "sensitive path" },
      ]);
      expect(out.skippedFiles).toEqual(["src/big.ts"]);
      expect(stdin).toContain("File: src/ref.ts\n");
      expect(stdin).toContain("File: src/server.ts\n");
      expect(stdin).not.toContain(AWS_KEY);
      expect(stdin).not.toContain("// big");
    });

    it("fails the area without calling claude when no file can be sent", async () => {
      commit(repo, { "src/keys.ts": `export const k = "${AWS_KEY}";\n` }, "keys");
      await planned([{ name: "Keys", why: "w", files: ["src/keys.ts"] }]);
      let called = false;
      const out = await draft({ next: true }, async () => ((called = true), reply([])));
      expect(called).toBe(false);
      expect(out).toMatchObject({ area: { status: "failed" }, error: expect.stringMatching(/no files could be sent/) });
    });

    it("leaves the area planned when claude is unavailable", async () => {
      await planned();
      const out = await draft({ next: true }, async () => {
        throw new ClaudeEnvError("claude is offline");
      });
      expect(out).toMatchObject({ area: { id: "a01-request-handling", status: "planned" }, error: "claude is offline", costUsd: null });
      expect(readPlan(key)!.areas[0]).toMatchObject({ status: "planned", costUsd: null });
    });

    it.each([
      ["a result error such as a budget overrun", () => new ClaudeResultError("error_max_budget_usd", "over budget", 0.52), 0.52],
      ["a timeout", () => new ClaudeLimitError("timed out"), null],
    ])("fails the area on %s, keeping its cost, and lets it be retried by id", async (_name, make, cost) => {
      await planned();
      const out = await draft({ next: true }, async () => {
        throw make();
      });
      expect(out).toMatchObject({ area: { status: "failed" }, error: make().message, costUsd: cost });
      expect(readPlan(key)!.areas[0]).toMatchObject({ status: "failed", error: make().message, costUsd: cost });
      // --next moves on; the failed area can be retried by id, and its costs add up.
      expect((await draft({ next: true }, async () => reply([card("src/ref.ts")], 0.01))).area?.id).toBe("a02-referrals");
      const retry = await draft({ areaId: "a01-request-handling" }, async () => reply([card("src/server.ts")], 0.01));
      expect(retry).toMatchObject({ area: { status: "drafted" }, cardsWritten: 1 });
      const area = readPlan(key)!.areas[0];
      expect(area).toMatchObject({ status: "drafted", costUsd: cost === null ? 0.01 : 0.53 });
      expect(area.error).toBeUndefined();
    });

    it("fails the area when the reply has no usable JSON", async () => {
      await planned();
      const out = await draft({ next: true }, async () => reply("no idea", 0.002));
      expect(out).toMatchObject({ area: { status: "failed" }, error: expect.stringMatching(/no JSON array/), costUsd: 0.002 });
    });

    it("refuses without a plan, for unknown, drafted or skipped areas, and while locked; --next with nothing left is a note", async () => {
      await expect(draft({ next: true }, async () => reply([]))).rejects.toThrow(/run codebrain baseline plan first/);
      await planned();
      await expect(draft({ areaId: "a09-nope" }, async () => reply([]))).rejects.toThrow(/no area a09-nope/);
      setAreaSkipped(key, "a02-referrals", true);
      await expect(draft({ areaId: "a02-referrals" }, async () => reply([]))).rejects.toThrow(/skipped.*unskip/);
      await draft({ next: true }, async () => reply([card("src/server.ts")]));
      await expect(draft({ areaId: "a01-request-handling" }, async () => reply([]))).rejects.toThrow(/already drafted/);
      expect(await draft({ next: true }, async () => reply([]))).toMatchObject({ area: null, note: expect.stringMatching(/no planned areas left/) });
      setAreaSkipped(key, "a02-referrals", false);
      const lock = acquireLock(key)!;
      try {
        await expect(draft({ next: true }, async () => reply([]))).rejects.toThrow(BaselineError);
      } finally {
        lock.release();
      }
    });
  });

  it("gives a re-plan at the same head new card ids, leaving the old plan's cards alone", async () => {
    await planned();
    await draftBaselineArea(key, { next: true, run: async () => reply([card("src/server.ts")]), now });
    const [kept] = listCards(key);
    writeCard(key, { ...kept, status: "kept" });
    await draftBaselineArea(key, { next: true, run: async () => reply([card("src/ref.ts")]), now });
    const draft = listCards(key).find((c) => c.id !== kept.id)!;
    const first = readPlan(key)!.nonce;
    await planBaseline(key, { fetch: false, force: true, run: async () => reply(twoAreas), now });
    expect(readPlan(key)!.nonce).not.toBe(first);
    for (const [i, file] of ["src/server.ts", "src/ref.ts"].entries()) {
      const out = await draftBaselineArea(key, { next: true, run: async () => reply([card(file, { front: `Changed ${i}?` })]), now });
      expect(out.cardsWritten).toBe(1);
    }
    expect(listCards(key)).toHaveLength(4);
    expect(readCard(key, kept.id)).toMatchObject({ status: "kept", body: { front: "What lives in src/server.ts?" } });
    expect(readCard(key, draft.id)).toMatchObject({ status: "draft", body: { front: "What lives in src/ref.ts?" } });
  });

  it("fails an area whose draft writes no cards, so it can be drafted again or skipped", async () => {
    await planned();
    const out = await draftBaselineArea(key, { next: true, run: async () => reply([card("src/ref.ts")], 0.01), now });
    expect(out).toMatchObject({ area: { status: "failed" }, cardsWritten: 0, error: expect.stringMatching(/^no usable cards: path not sent: src\/ref\.ts/), costUsd: 0.01 });
    expect(readPlan(key)!.areas[0]).toMatchObject({ status: "failed", cards: 0, error: expect.stringMatching(/no usable cards/) });
    const again = await draftBaselineArea(key, { areaId: "a01-request-handling", run: async () => reply([card("src/server.ts")]), now });
    expect(again).toMatchObject({ area: { status: "drafted" }, cardsWritten: 1 });
  });

  it("reports status with totals and the total known cost", async () => {
    expect(baselineStatus(key)).toEqual({ plan: null, totals: null, costUsd: null });
    await planned();
    await draftBaselineArea(key, { next: true, run: async () => reply([card("src/server.ts")], 0.01), now });
    setAreaSkipped(key, "a02-referrals", true);
    const status = baselineStatus(key);
    expect(status.totals).toEqual({ areas: 2, planned: 0, drafted: 1, skipped: 1, failed: 0, cards: 1 });
    expect(status.costUsd).toBe(0.014);
    expect(status.plan?.areas.map((a) => a.status)).toEqual(["drafted", "skipped"]);
  });

  it("skips planned or failed areas and unskips skipped ones, refusing anything else", async () => {
    await planned();
    expect(setAreaSkipped(key, "a01-request-handling", true)).toMatchObject({ id: "a01-request-handling", status: "skipped" });
    expect(() => setAreaSkipped(key, "a01-request-handling", true)).toThrow(/is skipped/);
    expect(setAreaSkipped(key, "a01-request-handling", false)).toMatchObject({ status: "planned" });
    expect(() => setAreaSkipped(key, "a01-request-handling", false)).toThrow(/isn't skipped/);
    expect(() => setAreaSkipped(key, "nope", true)).toThrow(/no area nope/);
    await draftBaselineArea(key, { areaId: "a02-referrals", run: async () => reply([card("src/ref.ts")]), now });
    expect(() => setAreaSkipped(key, "a02-referrals", true)).toThrow(/is drafted/);
  });

  it("reports a corrupt baseline.json clearly", () => {
    fs.mkdirSync(repoDir(key), { recursive: true });
    fs.writeFileSync(path.join(repoDir(key), "baseline.json"), JSON.stringify({ commit: "x" }));
    expect(() => readPlan(key)).toThrow(/baseline\.json is not a valid baseline plan/);
  });
});
