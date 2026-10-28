import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCapture } from "./capture.js";
import type { Card } from "./format.js";
import type { RunClaude } from "./generate.js";
import { dueCards, loadSchedule, recordGrade, type Grade } from "./schedule.js";
import { appendJsonl, appendLog, cardPath, connectRepo, findRepo, home, isSafeId, listCards, readCard, readJsonl, writeCard } from "./store.js";

export interface CliResult {
  /** 0 on success, 1 on a failure, 2 on bad arguments. */
  code: number;
  /** Printed as JSON on stdout. */
  out: unknown;
}

export interface CliDeps {
  now?: () => Date;
  run?: RunClaude;
}

const USAGE = "usage: codebrain <connect|capture|week|curate|due|grade|stats|card> [--repo <path>]";
const DECISIONS = ["keep", "fix", "drop"];
const GRADES = ["right", "wrong", "didnt-know"];

const usage = (error: string): CliResult => ({ code: 2, out: { error } });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A positive integer option, or undefined when absent; null when malformed. */
function count(value: string | undefined, min = 1): number | undefined | null {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) && Number(value) >= min ? Number(value) : null;
}

function connected(repo: string | undefined): string {
  const dir = path.resolve(repo ?? process.cwd());
  const found = findRepo(dir);
  if (!found) throw new Error(`${dir} is not connected to CodeBrain; run \`codebrain connect\` there first`);
  return found.key;
}

/** Capture runs detached, so its errors go to a log: the repo's capture.log, or the home-level one when no repo resolves. */
function logCaptureError(key: string | null, dir: string, msg: string): void {
  try {
    if (key) return appendLog(key, `capture failed: ${msg}`);
    fs.mkdirSync(home(), { recursive: true });
    fs.appendFileSync(path.join(home(), "capture-errors.log"), `${new Date().toISOString()} ${dir}: ${msg}\n`);
  } catch {
    // An unwritable home: the caller rethrows, which is all that's left.
  }
}

/** Reads a card for curate and grade, turning a bad or unknown id into a clear result instead of a stack trace. */
function lookupCard(key: string, id: string): Card | CliResult {
  try {
    return readCard(key, id);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { code: 1, out: { error: `no card ${id} in this repository` } };
    return { code: 1, out: { error: `card ${id} can't be read: ${message(e)}` } };
  }
}

const isResult = (v: Card | CliResult): v is CliResult => "code" in v;
const badId = (id: string): CliResult => usage(`invalid card id ${JSON.stringify(id)}`);

export async function main(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  const now = deps.now ?? (() => new Date());
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        since: { type: "string" },
        max: { type: "string" },
        limit: { type: "string" },
        "area-depth": { type: "string" },
        "no-fetch": { type: "boolean" },
      },
    });
  } catch (e) {
    if (command === "capture") logCaptureError(null, path.resolve(process.cwd()), message(e));
    return usage(`${message(e)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  switch (command) {
    case "connect": {
      const depth = count(values["area-depth"]);
      if (depth === null) return usage("--area-depth must be a positive integer");
      const key = connectRepo(path.resolve(positionals[0] ?? values.repo ?? process.cwd()), depth);
      return { code: 0, out: { connected: key } };
    }
    case "capture": {
      const dir = path.resolve(values.repo ?? process.cwd());
      let key: string | null = null;
      let capturing = false; // runCapture logs its own failures to capture.log
      try {
        key = connected(values.repo);
        const maxMerges = count(values.max);
        if (maxMerges === null) {
          logCaptureError(key, dir, "--max must be a positive integer");
          return usage("--max must be a positive integer");
        }
        capturing = true;
        const report = await runCapture(key, { since: values.since, maxMerges, fetch: !values["no-fetch"], run: deps.run, now });
        return { code: report.status === "failed" ? 1 : 0, out: report };
      } catch (e) {
        if (!capturing) logCaptureError(key, dir, message(e));
        throw e;
      }
    }
    case "week": {
      // Everything waiting for the user: all drafts, plus kept cards whose code changed or was removed.
      const items = listCards(connected(values.repo)).filter((c) => c.status === "draft" || (c.status === "kept" && c.anchor.status !== "fresh"));
      const areas: Record<string, { merge: string; title: string; cards: unknown[] }[]> = {};
      for (const c of items) {
        const groups = (areas[c.area] ??= []);
        let group = groups.find((g) => g.merge === c.merge);
        if (!group) groups.push((group = { merge: c.merge, title: c.mergeTitle, cards: [] }));
        group.cards.push({ id: c.id, status: c.status, anchor: c.anchor.status, path: c.anchor.path, symbol: c.anchor.symbol, body: c.body });
      }
      return { code: 0, out: { drafts: items.filter((c) => c.status === "draft").length, flagged: items.filter((c) => c.status === "kept").length, areas } };
    }
    case "curate": {
      const [id, decision] = positionals;
      if (!id || !DECISIONS.includes(decision ?? "") || positionals.length > 2) return usage("usage: codebrain curate <id> keep|fix|drop");
      if (!isSafeId(id)) return badId(id);
      const key = connected(values.repo);
      const card = lookupCard(key, id);
      if (isResult(card)) return card;
      const status = decision === "drop" ? "dropped" : "kept";
      writeCard(key, { ...card, status });
      appendJsonl(key, "curation.jsonl", { card: id, decision, at: now().toISOString() });
      return { code: 0, out: { id, status } };
    }
    case "due": {
      const limit = count(values.limit);
      if (limit === null) return usage("--limit must be a positive integer");
      const key = connected(values.repo);
      const due = dueCards(listCards(key), loadSchedule(key), now()).slice(0, limit ?? 10);
      return { code: 0, out: { due: due.map((c) => ({ id: c.id, area: c.area, path: c.anchor.path, codeChanged: c.anchor.status === "changed", body: c.body })) } };
    }
    case "grade": {
      const [id, grade] = positionals;
      if (!id || !GRADES.includes(grade ?? "") || positionals.length > 2) return usage("usage: codebrain grade <id> right|wrong|didnt-know");
      if (!isSafeId(id)) return badId(id);
      const key = connected(values.repo);
      const card = lookupCard(key, id);
      if (isResult(card)) return card;
      if (card.status !== "kept") return { code: 1, out: { error: `card ${id} is ${card.status}; only kept cards are reviewed` } };
      const next = recordGrade(key, id, grade as Grade, now());
      return { code: 0, out: { id, nextDue: next.due.toISOString() } };
    }
    case "stats": {
      const key = connected(values.repo);
      const cards = listCards(key);
      const byStatus = (s: string) => cards.filter((c) => c.status === s).length;
      const curation = readJsonl<{ decision: string }>(key, "curation.jsonl");
      const decided = (d: string) => curation.filter((c) => c.decision === d).length;
      const reviews = readJsonl<{ grade: string }>(key, "reviews.jsonl");
      return {
        code: 0,
        out: {
          cards: cards.length, draft: byStatus("draft"), kept: byStatus("kept"), dropped: byStatus("dropped"),
          changed: cards.filter((c) => c.anchor.status === "changed").length,
          orphaned: cards.filter((c) => c.anchor.status === "orphaned").length,
          curated: { keep: decided("keep"), fix: decided("fix"), drop: decided("drop") },
          reviews: reviews.length, right: reviews.filter((r) => r.grade === "right").length,
        },
      };
    }
    case "card": {
      const id = positionals[0];
      if (!id) return usage("usage: codebrain card <id>");
      if (!isSafeId(id)) return badId(id);
      return { code: 0, out: { path: cardPath(connected(values.repo), id) } };
    }
    default:
      return usage(USAGE);
  }
}
