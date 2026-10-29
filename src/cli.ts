import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { findSymbolLines, makeAnchor } from "./anchor.js";
import { isSignedIn, login, logout, resolveSite, type LoginDeps, type LoginOutput } from "./auth.js";
import {
  baselineStatus, draftBaselineArea, planBaseline, setAreaSkipped, type AreaDraftReport, type BaselineArea, type BaselineStatus, type PlanReport,
} from "./baseline.js";
import { runCapture, type CaptureReport } from "./capture.js";
import { areaOf, CARD_SOURCES, LETTERS, type Anchor, type AnchorStatus, type Card, type CardBody, type CardSource, type CardStatus } from "./format.js";
import type { RunClaude } from "./generate.js";
import { defaultBranch, fileAt, resolveCommit } from "./git.js";
import { connectRemote, RemoteError, toRemoteError, type Remote } from "./remote.js";
import { dueCards, loadSchedule, recordGrade, type Grade } from "./schedule.js";
import {
  acquireLock, appendJsonl, appendLog, cardPath, connectRepo, findRepo, home, isSafeId, listCardsReport, readCard, readJsonl, readState, writeCard,
  type CardListing, type RemoteLink, type RepoState,
} from "./store.js";
import { linkRepo, setRemoteAuth, submitPending, SYNC_BUDGET_MS, unlinkRepo, type LinkOutput, type UnlinkOutput } from "./sync.js";

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
/** One change's cards: a merge, or one baseline area (which shares the baseline commit with the other areas). */
export interface WeekGroup {
  merge: string;
  title: string;
  source: CardSource;
  cards: WeekCard[];
}
export interface WeekOutput {
  /** Draft cards waiting for a decision. */
  drafts: number;
  /** Kept cards whose code changed or was removed. */
  flagged: number;
  /** Groups by area, then by merge and title. */
  areas: Record<string, WeekGroup[]>;
  unreadable: UnreadableCard[];
  claudeUnavailable: ClaudeUnavailable | null;
  lastCaptureError: CaptureError | null;
  /** Why state.json couldn't be read (corrupt), or null when it reads fine. */
  stateError: string | null;
}
/**
 * `week` in a repo linked to the site: the site's week (its drafts and flagged cards, plus the deck's lesson)
 * with this machine's capture status, or, when the site can't be reached, the local week with `remoteError`.
 */
export type RemoteWeekOutput = WeekOutput & {
  site: string;
  /** The site's page for this week's cards, where decisions made here also show. */
  weekUrl: string;
  /** True when the cards came from the site. */
  remote: boolean;
  lesson?: { title: string; deckId: string } | null;
  /** Why the site couldn't be used; the cards shown are the local copies. */
  remoteError?: string;
  /** Set while the site refuses this machine's sign-in. */
  loginHint?: string;
};
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
/**
 * A due card in a linked repo. `id` is the site's card id, which show, answer and grade take. `localId` is
 * the local card with the same question, which gives the anchor; when none matches (the card was edited on
 * the site) it and the anchor fields are null.
 */
export interface RemoteDueCard {
  id: string;
  localId: string | null;
  area: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  codeChanged: boolean;
  body: DueBody;
}
export interface RemoteDueOutput {
  due: RemoteDueCard[];
  site: string;
  remote: true;
}
export interface GradeOutput {
  id: string;
  nextDue: string;
}
/** `grade` in a linked repo: the site schedules the card, and doesn't say when it's next due. */
export interface RemoteGradeOutput {
  id: string;
  recorded: boolean;
  site: string;
  remote: true;
}
/** Card and curation counts for the cards from one source. */
export interface SourceStats {
  cards: number;
  draft: number;
  kept: number;
  dropped: number;
  curated: { keep: number; fix: number; drop: number };
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
  /**
   * The same counts split by where the cards came from. A curate decision counts only while its card
   * file can be read, since the source is in the file.
   */
  bySource: Record<CardSource, SourceStats>;
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
  /** With a site id in a linked repo: the local card whose code is shown. */
  localId?: string;
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

/** `login` and `logout`: the site, and whether this machine is now signed in to it. Tokens are never printed. */
export type { LoginOutput };
/** `link`: the site's repo and deck, how many cards it now holds, and the cards it refused. */
export type { LinkOutput };
/** `unlink`: the site the repo was linked to, or null. */
export type { UnlinkOutput };

/** `baseline plan`: the plan saved (or the existing one), what was sent, and the call's cost. */
export type BaselinePlanOutput = PlanReport;
/** `baseline draft`: the area drafted, cards written, files not sent, and the call's cost. */
export type BaselineDraftOutput = AreaDraftReport;
/** `baseline status`: the plan with each area's status, totals, and the total known cost. */
export type BaselineStatusOutput = BaselineStatus;
/** `baseline skip` and `unskip`: the area afterwards. */
export type BaselineAreaOutput = BaselineArea;

export type CliOutput =
  | ErrorOutput | CurateUnreadable | ConnectOutput | CaptureOutput | WeekOutput | RemoteWeekOutput | CurateOutput
  | DueOutput | RemoteDueOutput | GradeOutput | RemoteGradeOutput | StatsOutput | CardOutput | AnswerOutput | ShowOutput
  | BaselinePlanOutput | BaselineDraftOutput | BaselineStatusOutput | BaselineAreaOutput | LoginOutput | LinkOutput | UnlinkOutput;

export interface CliResult {
  /** 0 on success, 1 on a failure, 2 on bad arguments. */
  code: number;
  /** Printed as JSON on stdout. */
  out: CliOutput;
}

export interface CliDeps {
  now?: () => Date;
  run?: RunClaude;
  /** Stand-ins for the browser sign-in, for tests. */
  login?: LoginDeps;
  /** Connects to the site with the stored sign-in; tests pass a fake. */
  connect?: (site: string) => Promise<Remote>;
}

const USAGE =
  "usage: repobrain <connect|capture|week|curate|show|due|answer|grade|stats|card|baseline> [--repo <path>], or repobrain login|logout|link [--site <url>], or repobrain unlink";
const BASELINE_USAGE =
  "usage: repobrain baseline plan [--force] [--no-fetch], baseline draft <area-id>|--next, baseline status, baseline skip <area-id>, baseline unskip <area-id>";
const CURATE_USAGE = "usage: repobrain curate <id> keep|fix|drop, or curate <id> fix --path P --lines S-E [--symbol X|--no-symbol]";
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

function connected(repo: string | undefined): { key: string; repoPath: string; areaDepth: number; link: RemoteLink | undefined } {
  const dir = path.resolve(repo ?? process.cwd());
  const found = findRepo(dir);
  if (!found) throw new Error(`${dir} is not connected to RepoBrain; run \`repobrain connect\` there first`);
  return { key: found.key, repoPath: found.config.path, areaDepth: found.config.areaDepth, link: found.config.remote };
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

// ---- Remote mode: a repo linked to the site uses the site's week, curation and reviews. ----

/** How long one call to the site may take, connecting included. */
const SITE_TIMEOUT_MS = 30_000;
const timed = { timeout: SITE_TIMEOUT_MS };
const LOGIN_HINT = "the site refused this machine's sign-in, or it expired: run repobrain login";

/** A card as the site's get_due_cards and get_deck list it: an mcq's `definition` is its correct choice. */
interface SiteCard {
  id: string;
  kind?: string;
  term: string;
  definition: string;
  choices?: string[];
  explanation?: string | null;
}

/** `p`, or a network error once `ms` pass first; a Remote that connects after that is closed. */
function connectWithin(p: Promise<Remote>, ms: number): Promise<Remote> {
  let late = false;
  let timer: NodeJS.Timeout | undefined;
  p.then((r) => (late ? r.close().catch(() => {}) : undefined), () => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => ((late = true), reject(new RemoteError(`the site didn't answer within ${ms / 1000}s`, "network"))), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const weekUrl = (link: RemoteLink): string => `${link.site}/repos/${encodeURIComponent(link.repoId)}/week`;

/** Connects to the linked site with the stored sign-in, runs `fn`, and closes the connection. */
async function withSite<T>(link: RemoteLink, deps: CliDeps, fn: (remote: Remote) => Promise<T>): Promise<T> {
  if (!isSignedIn(link.site)) throw new RemoteError(`not signed in to ${link.site}: run repobrain login --site ${link.site}`, "auth");
  const remote = await connectWithin((deps.connect ?? connectRemote)(link.site), SITE_TIMEOUT_MS);
  try {
    return await fn(remote);
  } finally {
    await remote.close().catch(() => {});
  }
}

/** Uploads the cards the site doesn't have as they are now. Skipped while a capture holds the lock: it uploads them itself. */
async function uploadPending(key: string, remote: Remote): Promise<void> {
  const lock = acquireLock(key);
  if (!lock) return;
  try {
    await submitPending(key, remote, { signal: AbortSignal.timeout(SYNC_BUDGET_MS), refresh: lock.refresh });
  } finally {
    lock.release();
  }
}

/** Records whether the site accepts the sign-in; an unwritable or corrupt state.json only loses the mark. */
function markAuth(key: string, expired: boolean): void {
  try {
    setRemoteAuth(key, expired);
  } catch {
    // stateStatus reports a corrupt state.json.
  }
}

function authExpired(key: string): boolean {
  try {
    return readState(key).remoteAuth === "expired";
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkWeek(v: unknown): WeekOutput & { lesson?: RemoteWeekOutput["lesson"] } {
  if (!isObj(v) || typeof v.drafts !== "number" || typeof v.flagged !== "number" || !isObj(v.areas)) {
    throw new RemoteError("get_week returned an unexpected result", "tool");
  }
  return v as unknown as WeekOutput;
}

function checkCards(tool: string, v: unknown): SiteCard[] {
  const cards = isObj(v) ? v.cards : undefined;
  const ok = Array.isArray(cards) && cards.every((c) => isObj(c) && typeof c.id === "string" && typeof c.term === "string" && typeof c.definition === "string");
  if (!ok) throw new RemoteError(`${tool} returned an unexpected result`, "tool");
  return cards as SiteCard[];
}

/** The deck's due cards. A deck the site has locked is an error, not an empty list. */
async function siteDue(remote: Remote, deckId: string): Promise<SiteCard[]> {
  const res = await remote.call<unknown>("get_due_cards", { deckId }, timed);
  if (isObj(res) && res.locked === true) throw new RemoteError(typeof res.message === "string" ? res.message : "the site has locked this deck", "tool");
  return checkCards("get_due_cards", res);
}

const DECK_PAGE = 200;

/** One of the deck's cards by its site id: from the due cards (where a review's cards are), else the whole deck. */
async function findSiteCard(remote: Remote, deckId: string, id: string): Promise<SiteCard | null> {
  const due = (await siteDue(remote, deckId)).find((c) => c.id === id);
  if (due) return due;
  for (let offset: number | null = 0, pages = 0; offset !== null && pages < 100; pages++) {
    const res: unknown = await remote.call<unknown>("get_deck", { deckId, offset, limit: DECK_PAGE }, timed);
    const hit = checkCards("get_deck", res).find((c) => c.id === id);
    if (hit) return hit;
    const next: unknown = isObj(res) ? res.nextOffset : null;
    offset = typeof next === "number" && next > offset ? next : null;
  }
  return null;
}

const isMcq = (c: SiteCard): boolean => c.kind === "MULTIPLE_CHOICE";

/** A site card's question side, as `due` prints it. */
const siteQuestion = (c: SiteCard): DueBody =>
  isMcq(c) ? { kind: "mcq", question: c.term, choices: c.choices ?? [] } : { kind: "flashcard", front: c.term };

/** What a card asks, as the site stores it (trimmed), so a site card can be matched to its local file. */
const questionKey = (q: DueBody): string =>
  JSON.stringify(q.kind === "mcq" ? ["mcq", q.question.trim(), q.choices.map((c) => c.trim())] : ["flashcard", q.front.trim()]);

/** The local card asking the same question as a site card: a kept one first, then any not dropped. */
function localMatch(cards: Card[], c: SiteCard): Card | null {
  const want = questionKey(siteQuestion(c));
  const same = cards.filter((l) => questionKey(questionOf(l.body)) === want);
  return same.find((l) => l.status === "kept") ?? same.find((l) => l.status !== "dropped") ?? same[0] ?? null;
}

/** The card body as curate_card takes it (the same shape as a submitted card's body). */
const siteBody = (b: CardBody): CardBody =>
  b.kind === "mcq"
    ? { kind: "mcq", question: b.question, choices: b.choices, correctChoice: b.correctChoice, explanation: b.explanation }
    : { kind: "flashcard", front: b.front, back: b.back };

async function curateOnSite(remote: Remote, key: string, id: string, decision: Decision, body?: CardBody): Promise<"kept" | "dropped"> {
  const res = await remote.call<unknown>("curate_card", { repo: key, id, decision, ...(body ? { body: siteBody(body) } : {}) }, timed);
  const curation = isObj(res) ? res.curation : undefined;
  if (curation !== "kept" && curation !== "dropped") throw new RemoteError("curate_card returned an unexpected result", "tool");
  return curation;
}

/** Whether the site has been sent this card (a corrupt state.json counts as yes: the site then says if it hasn't). */
function wasSubmitted(key: string, id: string): boolean {
  try {
    return readState(key).submitted?.[id] !== undefined;
  } catch {
    return true;
  }
}

/** The week from the local card files: drafts and flagged cards, grouped by area and then by change. */
function localWeek(key: string): WeekOutput {
  const { cards, unreadable } = listCardsReport(key);
  // Everything waiting for the user: all drafts, plus kept cards whose code changed or was removed.
  const items = cards.filter((c) => c.status === "draft" || (c.status === "kept" && c.anchor.status !== "fresh"));
  const areas: Record<string, WeekGroup[]> = {};
  for (const c of items) {
    const groups = (areas[c.area] ??= []);
    // Baseline areas share one commit, so the title tells them apart.
    let group = groups.find((g) => g.merge === c.merge && g.title === c.mergeTitle);
    if (!group) groups.push((group = { merge: c.merge, title: c.mergeTitle, source: c.source, cards: [] }));
    group.cards.push({
      id: c.id, status: c.status, anchor: c.anchor.status, path: c.anchor.path, startLine: c.anchor.startLine, endLine: c.anchor.endLine,
      symbol: c.anchor.symbol, body: bodyOutput(c.body),
    });
  }
  return {
    drafts: items.filter((c) => c.status === "draft").length, flagged: items.filter((c) => c.status === "kept").length, areas, unreadable,
    ...stateStatus(key),
  };
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
        force: { type: "boolean" },
        next: { type: "boolean" },
        site: { type: "string" },
      },
    });
  } catch (e) {
    if (command === "capture") logCaptureError(null, path.resolve(process.cwd()), message(e));
    return usage(`${message(e)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  switch (command) {
    case "login":
    case "logout": {
      if (positionals.length > 0) return usage(`unexpected argument ${JSON.stringify(positionals[0])}\n${USAGE}`);
      let site: string;
      try {
        site = resolveSite(values.site);
      } catch (e) {
        return usage(message(e));
      }
      return ok(command === "login" ? await login(site, deps.login) : logout(site));
    }
    case "link": {
      if (positionals.length > 0) return usage(`unexpected argument ${JSON.stringify(positionals[0])}\n${USAGE}`);
      let site: string;
      try {
        site = resolveSite(values.site);
      } catch (e) {
        return usage(message(e));
      }
      const { key, repoPath } = connected(values.repo);
      if (!isSignedIn(site)) return fail(`not signed in to ${site}: run repobrain login --site ${site}`);
      const remote = await (deps.connect ?? connectRemote)(site);
      try {
        return ok(await linkRepo(key, repoPath, site, remote, now));
      } finally {
        await remote.close().catch(() => {});
      }
    }
    case "unlink": {
      if (positionals.length > 0) return usage(`unexpected argument ${JSON.stringify(positionals[0])}\n${USAGE}`);
      return ok(unlinkRepo(connected(values.repo).key));
    }
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
        const report: CaptureOutput = await runCapture(key, { since: values.since, maxMerges, fetch: !values["no-fetch"], run: deps.run, now, connect: deps.connect });
        return { code: report.status === "failed" ? 1 : 0, out: report };
      } catch (e) {
        if (!capturing) logCaptureError(key, dir, message(e));
        throw e;
      }
    }
    case "week": {
      const { key, link } = connected(values.repo);
      const local = localWeek(key);
      if (!link) return ok(local);
      let out: RemoteWeekOutput;
      try {
        const week = await withSite(link, deps, async (remote) => {
          // Connecting sends the stored token, so the site has accepted the sign-in.
          markAuth(key, false);
          await uploadPending(key, remote);
          return checkWeek(await remote.call<unknown>("get_week", { repo: key }, timed));
        });
        // The site never sees this machine's card files or capture runs: those come from here.
        const { unreadable, claudeUnavailable, lastCaptureError, stateError } = local;
        out = { ...week, unreadable, claudeUnavailable, lastCaptureError, stateError, site: link.site, weekUrl: weekUrl(link), remote: true };
      } catch (e) {
        const err = toRemoteError(e);
        if (err.kind === "auth") markAuth(key, true);
        out = { ...local, site: link.site, weekUrl: weekUrl(link), remote: false, remoteError: err.message };
      }
      if (authExpired(key)) out.loginHint = LOGIN_HINT;
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
      const { key, repoPath, areaDepth, link } = connected(values.repo);
      /**
       * Saves the decision. In a linked repo the site takes it first (a fix with the card file's text), so a
       * refusal leaves the local file as it was; a card the site hasn't been sent yet is uploaded before, and
       * a moved anchor straight after.
       */
      const save = async (next: Card, out: CurateOutput): Promise<CliResult> => {
        const write = () => {
          writeCard(key, next);
          appendJsonl(key, "curation.jsonl", { card: id, decision, at: now().toISOString() });
        };
        if (!link) {
          write();
          return ok(out);
        }
        const status = await withSite(link, deps, async (remote) => {
          if (!wasSubmitted(key, id)) await uploadPending(key, remote);
          const curation = await curateOnSite(remote, key, id, decision, decision === "fix" ? next.body : undefined);
          write();
          // The site takes a kept card's anchor from a resubmit; if this fails, the next capture or week sends it.
          if (out.reanchored) await uploadPending(key, remote).catch(() => {});
          return curation;
        });
        return ok({ ...out, status } as CurateOutput);
      };
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
        return save(
          { ...card, status: "kept", area: areaOf(moved.path, areaDepth), anchor: moved },
          { id, status: "kept", reanchored: true, path: moved.path, startLine: moved.startLine, endLine: moved.endLine },
        );
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
      return save({ ...card, status: out.status, anchor }, out);
    }
    case "due": {
      const limit = count(values.limit);
      if (limit === null) return usage("--limit must be a positive integer");
      const { key, link } = connected(values.repo);
      if (link) {
        const site = await withSite(link, deps, (remote) => siteDue(remote, link.deckId));
        const cards = listCardsReport(key).cards;
        const out: RemoteDueOutput = {
          due: site.slice(0, limit ?? 10).map((c) => {
            const l = localMatch(cards, c);
            return {
              id: c.id, localId: l?.id ?? null, area: l?.area ?? null, path: l?.anchor.path ?? null, startLine: l?.anchor.startLine ?? null,
              endLine: l?.anchor.endLine ?? null, codeChanged: l?.anchor.status === "changed", body: siteQuestion(c),
            };
          }),
          site: link.site,
          remote: true,
        };
        return ok(out);
      }
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
      if (!id || !GRADES.includes(grade ?? "") || positionals.length > 2) return usage("usage: repobrain grade <id> right|wrong|didnt-know");
      if (!isSafeId(id)) return badId(id);
      const { key, link } = connected(values.repo);
      const found = lookupCard(key, id);
      if (link) {
        // The site schedules a linked repo's reviews, by its own card ids.
        if (!("missing" in found)) return fail(`${id} is a local card id; this repository is linked to ${link.site}, so grade the id \`repobrain due\` printed`);
        return withSite(link, deps, async (remote) => {
          if (!(await findSiteCard(remote, link.deckId, id))) return noCard(id);
          const res = await remote.call<unknown>("record_quiz_results", { deckId: link.deckId, outcomes: [{ cardId: id, correct: grade === "right" }] }, timed);
          const recorded = isObj(res) && typeof res.recorded === "number" && res.recorded > 0;
          return ok({ id, recorded, site: link.site, remote: true } satisfies RemoteGradeOutput);
        });
      }
      if ("missing" in found) return noCard(id);
      if ("reason" in found) return fail(`card ${id} can't be read: ${found.reason}`);
      if (found.card.status !== "kept") return fail(`card ${id} is ${found.card.status}; only kept cards are reviewed`);
      const next = recordGrade(key, id, grade as Grade, now());
      return ok({ id, nextDue: next.due.toISOString() } satisfies GradeOutput);
    }
    case "stats": {
      const { key } = connected(values.repo);
      const { cards, unreadable } = listCardsReport(key);
      const byStatus = (s: CardStatus, from = cards) => from.filter((c) => c.status === s).length;
      // A card curated twice counts once, by its latest decision.
      const latest = new Map<string, string>();
      for (const c of readJsonl<{ card: string; decision: string }>(key, "curation.jsonl")) latest.set(c.card, c.decision);
      const decided = (d: Decision, ids?: Set<string>) => [...latest].filter(([id, v]) => v === d && (!ids || ids.has(id))).length;
      const sourceStats = (source: CardSource): SourceStats => {
        const from = cards.filter((c) => c.source === source);
        const ids = new Set(from.map((c) => c.id));
        return {
          cards: from.length, draft: byStatus("draft", from), kept: byStatus("kept", from), dropped: byStatus("dropped", from),
          curated: { keep: decided("keep", ids), fix: decided("fix", ids), drop: decided("drop", ids) },
        };
      };
      const reviews = readJsonl<{ grade: string }>(key, "reviews.jsonl");
      const out: StatsOutput = {
        cards: cards.length, draft: byStatus("draft"), kept: byStatus("kept"), dropped: byStatus("dropped"),
        changed: cards.filter((c) => c.anchor.status === "changed").length,
        orphaned: cards.filter((c) => c.anchor.status === "orphaned").length,
        curated: { keep: decided("keep"), fix: decided("fix"), drop: decided("drop") },
        reviews: reviews.length, right: reviews.filter((r) => r.grade === "right").length,
        bySource: Object.fromEntries(CARD_SOURCES.map((s) => [s, sourceStats(s)])) as Record<CardSource, SourceStats>,
        unreadable,
        ...stateStatus(key),
      };
      return ok(out);
    }
    case "show": {
      const id = positionals[0];
      if (!id || positionals.length > 1) return usage("usage: repobrain show <id>");
      if (!isSafeId(id)) return badId(id);
      const { key, repoPath, link } = connected(values.repo);
      let found = lookupCard(key, id);
      let localId: string | undefined;
      if ("missing" in found && link) {
        // A site id, from `due`: the code comes from the local card asking the same question.
        const site = await withSite(link, deps, (remote) => findSiteCard(remote, link.deckId, id));
        if (!site) return noCard(id);
        const match = localMatch(listCardsReport(key).cards, site);
        if (!match) return fail(`card ${id} matches no card file in this repository; it may have been edited on the site`);
        found = { card: match };
        localId = match.id;
      }
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
        id, ...(localId ? { localId } : {}), status: card.status, anchor: a.status, path: a.path, startLine: a.startLine, endLine: a.endLine,
        atHead: { commit: tip.head, startLine, endLine, symbolFound, lines: blockText(at.content, startLine, endLine) },
        atCommit: { commit: a.commit, lines: blockText(fileAt(repoPath, a.commit, a.path), a.startLine, a.endLine) },
      };
      return ok(out);
    }
    case "answer": {
      const id = positionals[0];
      if (!id || positionals.length > 1) return usage("usage: repobrain answer <id>");
      if (!isSafeId(id)) return badId(id);
      const { key, link } = connected(values.repo);
      const found = lookupCard(key, id);
      if ("missing" in found && link) {
        // A site id, from `due`: the answer is the site's copy of the card.
        const site = await withSite(link, deps, (remote) => findSiteCard(remote, link.deckId, id));
        if (!site) return noCard(id);
        if (!isMcq(site)) return ok({ id, kind: "flashcard", back: site.definition } satisfies AnswerOutput);
        const correct = (site.choices ?? []).indexOf(site.definition);
        if (correct < 0 || correct >= LETTERS.length) return fail(`card ${id} on the site has no correct choice among its choices`);
        return ok({ id, kind: "mcq", correct: LETTERS[correct], explanation: site.explanation ?? "" } satisfies AnswerOutput);
      }
      if ("missing" in found) return noCard(id);
      if ("reason" in found) return fail(`card ${id} can't be read: ${found.reason}`);
      const { card } = found;
      if (card.status !== "kept") return fail(`card ${id} is ${card.status}; answers are only given for kept cards`);
      const b = card.body;
      const out: AnswerOutput =
        b.kind === "mcq" ? { id, kind: "mcq", correct: LETTERS[b.correctChoice], explanation: b.explanation } : { id, kind: "flashcard", back: b.back };
      return ok(out);
    }
    case "baseline": {
      const [sub, id, ...extra] = positionals;
      if (extra.length > 0) return usage(BASELINE_USAGE);
      if (id !== undefined && !isSafeId(id)) return usage(`invalid area id ${JSON.stringify(id)}`);
      switch (sub) {
        case "plan": {
          if (id !== undefined) return usage(BASELINE_USAGE);
          const { key } = connected(values.repo);
          const out: BaselinePlanOutput = await planBaseline(key, { force: values.force, fetch: !values["no-fetch"], run: deps.run, now });
          return { code: out.error ? 1 : 0, out };
        }
        case "draft": {
          if ((id === undefined) === !values.next) return usage(`draft takes an area id or --next; ${BASELINE_USAGE}`);
          const { key } = connected(values.repo);
          const out: BaselineDraftOutput = await draftBaselineArea(key, { areaId: id, next: values.next, run: deps.run, now, connect: deps.connect });
          return { code: out.error ? 1 : 0, out };
        }
        case "status":
          if (id !== undefined) return usage(BASELINE_USAGE);
          return ok(baselineStatus(connected(values.repo).key) satisfies BaselineStatusOutput);
        case "skip":
        case "unskip":
          if (id === undefined) return usage(BASELINE_USAGE);
          return ok((await setAreaSkipped(connected(values.repo).key, id, sub === "skip")) satisfies BaselineAreaOutput);
        default:
          return usage(BASELINE_USAGE);
      }
    }
    case "card": {
      const id = positionals[0];
      if (!id) return usage("usage: repobrain card <id>");
      if (!isSafeId(id)) return badId(id);
      const file = cardPath(connected(values.repo).key, id);
      if (!fs.existsSync(file)) return noCard(id);
      return ok({ path: file } satisfies CardOutput);
    }
    default:
      return usage(USAGE);
  }
}
