import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findSymbolLines, makeAnchor } from "./anchor.js";
import { runCapture, type CaptureReport } from "./capture.js";
import { areaOf, LETTERS, type Anchor, type AnchorStatus, type Card, type CardBody, type CardStatus } from "./format.js";
import type { RunClaude } from "./generate.js";
import { defaultBranch, fileAt, resolveCommit } from "./git.js";
import { dueCards, loadSchedule, recordGrade, type Grade } from "./schedule.js";
import {
  appendJsonl, appendLog, cardPath, connectRepo, findRepo, home, isSafeId, listCardsReport, readCard, readJsonl, readState, writeCard,
  type CardListing, type RepoState,
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
/** Set while capture can't reach claude (missing, logged out, offline, rate-limited), from when it began. */
export type ClaudeUnavailable = NonNullable<RepoState["unavailable"]>;
/** The last unexpected capture failure, such as a git error, until a capture completes. */
export type CaptureError = NonNullable<RepoState["lastError"]>;

export interface ConnectOutput {
  connected: string;
}
export type CaptureOutput = CaptureReport;
export interface WeekCard {
  id: string;
  status: CardStatus;
  anchor: AnchorStatus;
  path: string;
  startLine: number;
  endLine: number;
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
  claudeUnavailable: ClaudeUnavailable | null;
  lastCaptureError: CaptureError | null;
  /** Why state.json couldn't be read (corrupt), or null when it reads fine. */
  stateError: string | null;
}
/** A kept card whose code changed is re-anchored at the default branch's head, and then carries its new range. */
export type CurateOutput =
  | { id: string; status: "kept" | "dropped"; reanchored: false }
  | { id: string; status: "kept"; reanchored: true; path: string; startLine: number; endLine: number };
/** A due card's question only: Claude Code shows command output to the user, so answers come from `answer`. */
export type DueBody = { kind: "mcq"; question: string; choices: string[] } | { kind: "flashcard"; front: string };
export interface DueCard {
  id: string;
  area: string;
  path: string;
  startLine: number;
  endLine: number;
  codeChanged: boolean;
  body: DueBody;
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
  claudeUnavailable: ClaudeUnavailable | null;
  lastCaptureError: CaptureError | null;
  /** Why state.json couldn't be read (corrupt), or null when it reads fine. */
  stateError: string | null;
}
export interface CardOutput {
  path: string;
}
/** A kept card's answer, asked for once the user has answered. */
export type AnswerOutput = { id: string; kind: "mcq"; correct: string; explanation: string } | { id: string; kind: "flashcard"; back: string };
export interface ShowOutput {
  id: string;
  status: CardStatus;
  anchor: AnchorStatus;
  /** The card's stored anchor. */
  path: string;
  startLine: number;
  endLine: number;
  /**
   * The block at the default branch's head: the stored range, moved with the symbol's line when the
   * symbol is still there, and clamped to the file's last line. `symbolFound` is false when the card
   * has no symbol or it's gone at head, so the range is only a guess. `lines` is null when the file is gone.
   */
  atHead: { commit: string; startLine: number; endLine: number; symbolFound: boolean; lines: string | null };
  /** The block as the card was written against it; `lines` is null if that commit or file can't be read. */
  atCommit: { commit: string; lines: string | null };
}

export type CliOutput =
  | ErrorOutput | CurateUnreadable | ConnectOutput | CaptureOutput | WeekOutput | CurateOutput
  | DueOutput | GradeOutput | StatsOutput | CardOutput | AnswerOutput | ShowOutput;

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

const USAGE = "usage: codebrain <connect|capture|week|curate|show|due|answer|grade|stats|card> [--repo <path>]";
const CURATE_USAGE = "usage: codebrain curate <id> keep|fix|drop, or curate <id> fix --path P --lines S-E [--symbol X|--no-symbol]";
const DECISIONS = ["keep", "fix", "drop"] as const;
type Decision = (typeof DECISIONS)[number];
const GRADES = ["right", "wrong", "didnt-know"];

const ok = (out: CliOutput): CliResult => ({ code: 0, out });
const fail = (error: string): CliResult => ({ code: 1, out: { error } });
const usage = (error: string): CliResult => ({ code: 2, out: { error } });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const badId = (id: string): CliResult => usage(`invalid card id ${JSON.stringify(id)}`);
const noCard = (id: string): CliResult => fail(`no card ${id} in this repository`);

/** The question side only, so printing it never shows the answer. */
function questionOf(body: CardBody): DueBody {
  return body.kind === "mcq" ? { kind: "mcq", question: body.question, choices: body.choices } : { kind: "flashcard", front: body.front };
}

function bodyOutput(body: CardBody): BodyOutput {
  return body.kind === "mcq" ? { ...body, correct: LETTERS[body.correctChoice] } : body;
}

/** A positive integer option, or undefined when absent; null when malformed. */
function count(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) && Number(value) >= 1 ? Number(value) : null;
}

function connected(repo: string | undefined): { key: string; repoPath: string; areaDepth: number } {
  const dir = path.resolve(repo ?? process.cwd());
  const found = findRepo(dir);
  if (!found) throw new Error(`${dir} is not connected to CodeBrain; run \`codebrain connect\` there first`);
  return { key: found.key, repoPath: found.config.path, areaDepth: found.config.areaDepth };
}

/** A relative path inside the repo with no `..`, normalised; null when unsafe. */
function repoRelativePath(p: string): string | null {
  if (!p || p.includes("\\") || p.includes("\0") || path.posix.isAbsolute(p)) return null;
  if (p.split("/").includes("..")) return null;
  const normal = path.posix.normalize(p);
  return normal === "." || normal.endsWith("/") ? null : normal;
}

/** "S-E" with positive integers and S <= E, or null. */
function lineRange(s: string): { start: number; end: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(s);
  if (!m) return null;
  const [start, end] = [Number(m[1]), Number(m[2])];
  return start >= 1 && start <= end ? { start, end } : null;
}

const blockText = (content: string | null, start: number, end: number): string | null =>
  content === null ? null : content.split("\n").slice(start - 1, end).join("\n");

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

/** Capture state for week and stats; a corrupt state.json is reported rather than making curation unusable. */
function stateStatus(key: string): { claudeUnavailable: ClaudeUnavailable | null; lastCaptureError: CaptureError | null; stateError: string | null } {
  try {
    const state = readState(key);
    return { claudeUnavailable: state.unavailable ?? null, lastCaptureError: state.lastError ?? null, stateError: null };
  } catch (e) {
    return { claudeUnavailable: null, lastCaptureError: null, stateError: message(e) };
  }
}

function nearest(lines: number[], to: number): number | null {
  return lines.length === 0 ? null : lines.reduce((best, l) => (Math.abs(l - to) < Math.abs(best - to) ? l : best));
}

/**
 * The card's anchor re-made at the default branch's head, or null when the code there can't hold it.
 * With a symbol, the range moves with the symbol's line (the occurrence nearest the old block),
 * so lines inserted above don't shift the card onto other code; a symbol gone at head is a failure.
 */
function reanchor(repoPath: string, card: Card): Anchor | null {
  const tip = defaultHead(repoPath);
  if (!tip) return null;
  const at = locate(repoPath, card.anchor, tip.head);
  if (at.symbolMissing) return null;
  const a = card.anchor;
  return makeAnchor(repoPath, tip.head, a.path, at.startLine, at.endLine, a.symbol);
}

/** The default branch and the commit at its tip, or null when there is none. */
function defaultHead(repoPath: string): { branch: string; head: string } | null {
  const branch = defaultBranch(repoPath);
  const head = branch && resolveCommit(repoPath, branch);
  return branch && head ? { branch, head } : null;
}

/**
 * Where an anchor's block is at `head`: its range moved with the symbol's line (the occurrence
 * nearest the old one), or the same range when it has no symbol or the symbol is gone at head.
 */
function locate(repoPath: string, a: Anchor, head: string) {
  const content = fileAt(repoPath, head, a.path);
  let shift = 0;
  let symbolMissing = false;
  if (a.symbol) {
    const oldLine = nearest(findSymbolLines(fileAt(repoPath, a.commit, a.path), a.symbol), a.startLine) ?? a.startLine;
    const newLine = nearest(findSymbolLines(content, a.symbol), oldLine);
    if (newLine === null) symbolMissing = true;
    else shift = newLine - oldLine;
  }
  return { content, startLine: a.startLine + shift, endLine: a.endLine + shift, symbolMissing };
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
        path: { type: "string" },
        lines: { type: "string" },
        symbol: { type: "string" },
        "no-symbol": { type: "boolean" },
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
      const { key } = connected(values.repo);
      const { cards, unreadable } = listCardsReport(key);
      // Everything waiting for the user: all drafts, plus kept cards whose code changed or was removed.
      const items = cards.filter((c) => c.status === "draft" || (c.status === "kept" && c.anchor.status !== "fresh"));
      const areas: Record<string, WeekGroup[]> = {};
      for (const c of items) {
        const groups = (areas[c.area] ??= []);
        let group = groups.find((g) => g.merge === c.merge);
        if (!group) groups.push((group = { merge: c.merge, title: c.mergeTitle, cards: [] }));
        group.cards.push({
          id: c.id, status: c.status, anchor: c.anchor.status, path: c.anchor.path, startLine: c.anchor.startLine, endLine: c.anchor.endLine,
          symbol: c.anchor.symbol, body: bodyOutput(c.body),
        });
      }
      const out: WeekOutput = {
        drafts: items.filter((c) => c.status === "draft").length, flagged: items.filter((c) => c.status === "kept").length, areas, unreadable,
        ...stateStatus(key),
      };
      return ok(out);
    }
    case "curate": {
      const [id, decision] = positionals as [string?, Decision?];
      if (!id || !decision || !DECISIONS.includes(decision) || positionals.length > 2) return usage(CURATE_USAGE);
      if (!isSafeId(id)) return badId(id);
      const repoint = values.path !== undefined || values.lines !== undefined || values.symbol !== undefined || values["no-symbol"] === true;
      let target: { path: string; start: number; end: number } | null = null;
      if (repoint) {
        if (decision !== "fix") return usage(`--path, --lines and --symbol only go with fix; ${CURATE_USAGE}`);
        if (values.path === undefined || values.lines === undefined) return usage(`fix re-points with both --path P and --lines S-E; ${CURATE_USAGE}`);
        if (values.symbol !== undefined && values["no-symbol"]) return usage("use --symbol or --no-symbol, not both");
        const p = repoRelativePath(values.path);
        if (p === null) return usage("--path must be a relative path inside the repository, with no ..");
        const range = lineRange(values.lines);
        if (range === null) return usage("--lines must be S-E with positive integers and S <= E");
        target = { path: p, ...range };
      }
      const { key, repoPath, areaDepth } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found) return noCard(id);
      if ("reason" in found) {
        const out: CurateUnreadable = {
          error: `the edit broke the card: ${found.reason}; fix the file and run curate again`, unreadable: true, path: cardPath(key, id), reason: found.reason,
        };
        return { code: 1, out };
      }
      const card = found.card;
      if (target) {
        // Any live card, fresh ones included: a re-anchor can land on the wrong code.
        if (card.status === "dropped") return fail(`card ${id} is dropped; only cards that aren't dropped can be re-pointed`);
        const tip = defaultHead(repoPath);
        if (!tip) return fail(`can't re-point ${id}: the repository has no default branch with commits`);
        if (values.symbol !== undefined) {
          const content = fileAt(repoPath, tip.head, target.path);
          // makeAnchor would quietly drop a symbol it can't find; an explicit one must be there.
          if (content !== null && findSymbolLines(content, values.symbol).length === 0) {
            return fail(`symbol ${values.symbol} not found in ${target.path} at HEAD`);
          }
        }
        const symbol = values["no-symbol"] ? null : (values.symbol ?? card.anchor.symbol);
        const moved = makeAnchor(repoPath, tip.head, target.path, target.start, target.end, symbol);
        if (!moved) {
          return fail(
            `can't anchor ${id} at ${target.path}:${target.start}-${target.end} on ${tip.branch}: the file is missing there, or those lines are out of range or too trivial`,
          );
        }
        writeCard(key, { ...card, status: "kept", area: areaOf(moved.path, areaDepth), anchor: moved });
        appendJsonl(key, "curation.jsonl", { card: id, decision, at: now().toISOString() });
        return ok({ id, status: "kept", reanchored: true, path: moved.path, startLine: moved.startLine, endLine: moved.endLine } satisfies CurateOutput);
      }
      let out: CurateOutput = { id, status: decision === "drop" ? "dropped" : "kept", reanchored: false };
      let anchor = card.anchor;
      if (decision !== "drop") {
        if (card.anchor.status === "orphaned") return fail(`the code for ${id} was removed; drop it, or re-point it with \`curate ${id} fix --path P --lines S-E\``);
        if (card.status === "kept" && card.anchor.status === "changed") {
          const moved = reanchor(repoPath, card);
          if (!moved) return fail(`can't re-anchor ${id}: re-point it with \`curate ${id} fix --path P --lines S-E\`, or drop it`);
          anchor = moved;
          out = { id, status: "kept", reanchored: true, path: moved.path, startLine: moved.startLine, endLine: moved.endLine };
        }
      }
      writeCard(key, { ...card, status: out.status, anchor });
      appendJsonl(key, "curation.jsonl", { card: id, decision, at: now().toISOString() });
      return ok(out);
    }
    case "due": {
      const limit = count(values.limit);
      if (limit === null) return usage("--limit must be a positive integer");
      const { key } = connected(values.repo);
      const due = dueCards(listCardsReport(key).cards, loadSchedule(key), now()).slice(0, limit ?? 10);
      const out: DueOutput = {
        due: due.map((c) => ({
          id: c.id, area: c.area, path: c.anchor.path, startLine: c.anchor.startLine, endLine: c.anchor.endLine,
          codeChanged: c.anchor.status === "changed", body: questionOf(c.body),
        })),
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
        ...stateStatus(key),
      };
      return ok(out);
    }
    case "show": {
      const id = positionals[0];
      if (!id || positionals.length > 1) return usage("usage: codebrain show <id>");
      if (!isSafeId(id)) return badId(id);
      const { key, repoPath } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found) return noCard(id);
      if ("reason" in found) return fail(`card ${id} can't be read: ${found.reason}`);
      const { card } = found;
      const a = card.anchor;
      const tip = defaultHead(repoPath);
      if (!tip) return fail(`can't show ${id}: the repository has no default branch with commits`);
      const at = locate(repoPath, a, tip.head);
      let { startLine, endLine } = at;
      if (at.content !== null) {
        const all = at.content.split("\n");
        const lastLine = Math.max(1, at.content.endsWith("\n") ? all.length - 1 : all.length);
        startLine = Math.min(startLine, lastLine);
        endLine = Math.max(startLine, Math.min(endLine, lastLine));
      }
      const symbolFound = a.symbol !== null && at.content !== null && !at.symbolMissing;
      const out: ShowOutput = {
        id, status: card.status, anchor: a.status, path: a.path, startLine: a.startLine, endLine: a.endLine,
        atHead: { commit: tip.head, startLine, endLine, symbolFound, lines: blockText(at.content, startLine, endLine) },
        atCommit: { commit: a.commit, lines: blockText(fileAt(repoPath, a.commit, a.path), a.startLine, a.endLine) },
      };
      return ok(out);
    }
    case "answer": {
      const id = positionals[0];
      if (!id || positionals.length > 1) return usage("usage: codebrain answer <id>");
      if (!isSafeId(id)) return badId(id);
      const { key } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found) return noCard(id);
      if ("reason" in found) return fail(`card ${id} can't be read: ${found.reason}`);
      const { card } = found;
      if (card.status !== "kept") return fail(`card ${id} is ${card.status}; answers are only given for kept cards`);
      const b = card.body;
      const out: AnswerOutput =
        b.kind === "mcq" ? { id, kind: "mcq", correct: LETTERS[b.correctChoice], explanation: b.explanation } : { id, kind: "flashcard", back: b.back };
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
