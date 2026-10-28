import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { makeAnchor } from "./anchor.js";
import { runCapture, type CaptureReport } from "./capture.js";
import { LETTERS, type AnchorStatus, type Card, type CardBody, type CardStatus } from "./format.js";
import type { RunClaude } from "./generate.js";
import { defaultBranch, resolveCommit } from "./git.js";
import { dueCards, loadSchedule, recordGrade, type Grade } from "./schedule.js";
import {
  appendJsonl, appendLog, cardPath, connectRepo, findRepo, home, isSafeId, listCardsReport, readCard, readJsonl, writeCard,
  type CardListing,
} from "./store.js";

// ---- Output shapes: every command prints one of these as JSON on stdout. ----

export interface ErrorOutput {
  error: string;
}
/** curate's error when the card file no longer parses, usually after a broken fix edit. */
export interface CurateUnreadable extends ErrorOutput {
  unreadable: true;
  path: string;
  reason: string;
}
/** A card body as printed: an mcq also carries its answer as a letter, `correct`. */
export type BodyOutput = Extract<CardBody, { kind: "flashcard" }> | (Extract<CardBody, { kind: "mcq" }> & { correct: string });
export type UnreadableCard = CardListing["unreadable"][number];

export interface ConnectOutput {
  connected: string;
}
export type CaptureOutput = CaptureReport;
export interface WeekCard {
  id: string;
  status: CardStatus;
  anchor: AnchorStatus;
  path: string;
  symbol: string | null;
  body: BodyOutput;
}
export interface WeekGroup {
  merge: string;
  title: string;
  cards: WeekCard[];
}
export interface WeekOutput {
  /** Draft cards waiting for a decision. */
  drafts: number;
  /** Kept cards whose code changed or was removed. */
  flagged: number;
  /** Groups by area, then by merge. */
  areas: Record<string, WeekGroup[]>;
  unreadable: UnreadableCard[];
}
export interface CurateOutput {
  id: string;
  status: "kept" | "dropped";
  /** Whether a kept card whose code changed was re-anchored at the default branch's head. */
  reanchored: boolean;
}
export interface DueCard {
  id: string;
  area: string;
  path: string;
  codeChanged: boolean;
  body: BodyOutput;
}
export interface DueOutput {
  due: DueCard[];
}
export interface GradeOutput {
  id: string;
  nextDue: string;
}
export interface StatsOutput {
  cards: number;
  draft: number;
  kept: number;
  dropped: number;
  changed: number;
  orphaned: number;
  /** Each card's latest curate decision. */
  curated: { keep: number; fix: number; drop: number };
  reviews: number;
  right: number;
  unreadable: UnreadableCard[];
}
export interface CardOutput {
  path: string;
}

export type CliOutput =
  | ErrorOutput | CurateUnreadable | ConnectOutput | CaptureOutput | WeekOutput | CurateOutput
  | DueOutput | GradeOutput | StatsOutput | CardOutput;

export interface CliResult {
  /** 0 on success, 1 on a failure, 2 on bad arguments. */
  code: number;
  /** Printed as JSON on stdout. */
  out: CliOutput;
}

export interface CliDeps {
  now?: () => Date;
  run?: RunClaude;
}

const USAGE = "usage: codebrain <connect|capture|week|curate|due|grade|stats|card> [--repo <path>]";
const DECISIONS = ["keep", "fix", "drop"] as const;
type Decision = (typeof DECISIONS)[number];
const GRADES = ["right", "wrong", "didnt-know"];

const ok = (out: CliOutput): CliResult => ({ code: 0, out });
const fail = (error: string): CliResult => ({ code: 1, out: { error } });
const usage = (error: string): CliResult => ({ code: 2, out: { error } });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const badId = (id: string): CliResult => usage(`invalid card id ${JSON.stringify(id)}`);
const noCard = (id: string): CliResult => fail(`no card ${id} in this repository`);

function bodyOutput(body: CardBody): BodyOutput {
  return body.kind === "mcq" ? { ...body, correct: LETTERS[body.correctChoice] } : body;
}

/** A positive integer option, or undefined when absent; null when malformed. */
function count(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) && Number(value) >= 1 ? Number(value) : null;
}

function connected(repo: string | undefined): { key: string; repoPath: string } {
  const dir = path.resolve(repo ?? process.cwd());
  const found = findRepo(dir);
  if (!found) throw new Error(`${dir} is not connected to CodeBrain; run \`codebrain connect\` there first`);
  return { key: found.key, repoPath: found.config.path };
}

/** Capture runs detached, so its errors go to a log: the repo's capture.log, or the home-level one when no repo resolves. */
function logCaptureError(key: string | null, dir: string, msg: string): void {
  try {
    if (key) return appendLog(key, `capture failed: ${msg}`);
    fs.mkdirSync(home(), { recursive: true });
    fs.appendFileSync(path.join(home(), "capture-errors.log"), `${new Date().toISOString()} ${dir}: ${msg}\n`);
  } catch {
    // An unwritable home: the caller reports the error, which is all that's left.
  }
}

/** Reads a card, telling a missing file apart from one that doesn't parse. */
function lookupCard(key: string, id: string): { card: Card } | { missing: true } | { reason: string } {
  try {
    return { card: readCard(key, id) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { reason: message(e) };
  }
}

/** The card's anchor re-made at the default branch's head, or null when the code there can't hold it. */
function reanchor(repoPath: string, card: Card) {
  const branch = defaultBranch(repoPath);
  const head = branch && resolveCommit(repoPath, branch);
  if (!head) return null;
  const a = card.anchor;
  return makeAnchor(repoPath, head, a.path, a.startLine, a.endLine, a.symbol);
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  try {
    return await dispatch(argv, deps);
  } catch (e) {
    return fail(message(e));
  }
}

async function dispatch(argv: string[], deps: CliDeps): Promise<CliResult> {
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
      return ok({ connected: connectRepo(path.resolve(positionals[0] ?? values.repo ?? process.cwd()), depth) } satisfies ConnectOutput);
    }
    case "capture": {
      const dir = path.resolve(values.repo ?? process.cwd());
      let key: string | null = null;
      let capturing = false; // runCapture logs its own failures to capture.log
      try {
        key = connected(values.repo).key;
        const maxMerges = count(values.max);
        if (maxMerges === null) {
          logCaptureError(key, dir, "--max must be a positive integer");
          return usage("--max must be a positive integer");
        }
        capturing = true;
        const report: CaptureOutput = await runCapture(key, { since: values.since, maxMerges, fetch: !values["no-fetch"], run: deps.run, now });
        return { code: report.status === "failed" ? 1 : 0, out: report };
      } catch (e) {
        if (!capturing) logCaptureError(key, dir, message(e));
        throw e;
      }
    }
    case "week": {
      const { cards, unreadable } = listCardsReport(connected(values.repo).key);
      // Everything waiting for the user: all drafts, plus kept cards whose code changed or was removed.
      const items = cards.filter((c) => c.status === "draft" || (c.status === "kept" && c.anchor.status !== "fresh"));
      const areas: Record<string, WeekGroup[]> = {};
      for (const c of items) {
        const groups = (areas[c.area] ??= []);
        let group = groups.find((g) => g.merge === c.merge);
        if (!group) groups.push((group = { merge: c.merge, title: c.mergeTitle, cards: [] }));
        group.cards.push({ id: c.id, status: c.status, anchor: c.anchor.status, path: c.anchor.path, symbol: c.anchor.symbol, body: bodyOutput(c.body) });
      }
      const out: WeekOutput = {
        drafts: items.filter((c) => c.status === "draft").length, flagged: items.filter((c) => c.status === "kept").length, areas, unreadable,
      };
      return ok(out);
    }
    case "curate": {
      const [id, decision] = positionals as [string?, Decision?];
      if (!id || !decision || !DECISIONS.includes(decision) || positionals.length > 2) return usage("usage: codebrain curate <id> keep|fix|drop");
      if (!isSafeId(id)) return badId(id);
      const { key, repoPath } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found) return noCard(id);
      if ("reason" in found) {
        const out: CurateUnreadable = {
          error: `the edit broke the card: ${found.reason}; fix the file and run curate again`, unreadable: true, path: cardPath(key, id), reason: found.reason,
        };
        return { code: 1, out };
      }
      let card = found.card;
      let reanchored = false;
      if (decision !== "drop") {
        if (card.anchor.status === "orphaned") return fail(`the code for ${id} was removed; drop it or fix its anchor`);
        if (card.status === "kept" && card.anchor.status === "changed") {
          const anchor = reanchor(repoPath, card);
          if (!anchor) return fail(`can't re-anchor ${id}: fix the card or drop it`);
          card = { ...card, anchor };
          reanchored = true;
        }
      }
      const status = decision === "drop" ? "dropped" : "kept";
      writeCard(key, { ...card, status });
      appendJsonl(key, "curation.jsonl", { card: id, decision, at: now().toISOString() });
      return ok({ id, status, reanchored } satisfies CurateOutput);
    }
    case "due": {
      const limit = count(values.limit);
      if (limit === null) return usage("--limit must be a positive integer");
      const { key } = connected(values.repo);
      const due = dueCards(listCardsReport(key).cards, loadSchedule(key), now()).slice(0, limit ?? 10);
      const out: DueOutput = {
        due: due.map((c) => ({ id: c.id, area: c.area, path: c.anchor.path, codeChanged: c.anchor.status === "changed", body: bodyOutput(c.body) })),
      };
      return ok(out);
    }
    case "grade": {
      const [id, grade] = positionals;
      if (!id || !GRADES.includes(grade ?? "") || positionals.length > 2) return usage("usage: codebrain grade <id> right|wrong|didnt-know");
      if (!isSafeId(id)) return badId(id);
      const { key } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found) return noCard(id);
      if ("reason" in found) return fail(`card ${id} can't be read: ${found.reason}`);
      if (found.card.status !== "kept") return fail(`card ${id} is ${found.card.status}; only kept cards are reviewed`);
      const next = recordGrade(key, id, grade as Grade, now());
      return ok({ id, nextDue: next.due.toISOString() } satisfies GradeOutput);
    }
    case "stats": {
      const { key } = connected(values.repo);
      const { cards, unreadable } = listCardsReport(key);
      const byStatus = (s: CardStatus) => cards.filter((c) => c.status === s).length;
      // A card curated twice counts once, by its latest decision.
      const latest = new Map<string, string>();
      for (const c of readJsonl<{ card: string; decision: string }>(key, "curation.jsonl")) latest.set(c.card, c.decision);
      const decided = (d: Decision) => [...latest.values()].filter((v) => v === d).length;
      const reviews = readJsonl<{ grade: string }>(key, "reviews.jsonl");
      const out: StatsOutput = {
        cards: cards.length, draft: byStatus("draft"), kept: byStatus("kept"), dropped: byStatus("dropped"),
        changed: cards.filter((c) => c.anchor.status === "changed").length,
        orphaned: cards.filter((c) => c.anchor.status === "orphaned").length,
        curated: { keep: decided("keep"), fix: decided("fix"), drop: decided("drop") },
        reviews: reviews.length, right: reviews.filter((r) => r.grade === "right").length,
        unreadable,
      };
      return ok(out);
    }
    case "card": {
      const id = positionals[0];
      if (!id) return usage("usage: codebrain card <id>");
      if (!isSafeId(id)) return badId(id);
      const file = cardPath(connected(values.repo).key, id);
      if (!fs.existsSync(file)) return noCard(id);
      return ok({ path: file } satisfies CardOutput);
    }
    default:
      return usage(USAGE);
  }
}
