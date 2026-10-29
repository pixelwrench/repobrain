import { createHash } from "node:crypto";
import path from "node:path";
import type { AnchorStatus, Card, CardBody, CardSource, CardStatus } from "./format.js";
import { isSignedIn } from "./auth.js";
import { connectRemote, RemoteError, type Remote } from "./remote.js";
import { acquireLock, appendLog, listCards, loadConfig, readState, setRemote, writeState, type RemoteLink } from "./store.js";

// ---- The site's contract: the shapes link_repo and submit_cards take and return. ----

/** A card as `submit_cards` takes it. The field names match the site's `submittedCard`. */
export interface SubmittedCard {
  id: string;
  area: string;
  status: CardStatus;
  body: CardBody;
  anchor: {
    commit: string;
    path: string;
    symbol: string | null;
    startLine: number;
    endLine: number;
    fingerprint: string;
    status: AnchorStatus;
  };
}

export interface SubmitCardsInput {
  repo: string;
  merge: string;
  mergeTitle: string;
  source: CardSource;
  cards: SubmittedCard[];
}

export interface Rejection {
  id: string;
  reason: string;
}

export interface SubmitCardsResult {
  accepted: string[];
  unchanged: string[];
  rejected: Rejection[];
}

export interface LinkRepoResult {
  repoId: string;
  deckId: string;
  created: boolean;
}

/** The site takes at most this many cards per `submit_cards` call. */
export const BATCH_SIZE = 20;
const MAX_TITLE = 300;
const MAX_NAME = 100;
const REPO_KEY = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * `s` cut to at most `max` UTF-16 units (what the site's length limits count), never splitting a surrogate
 * pair, so an emoji at the cut doesn't leave half a character.
 */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** The merge title as sent: trimmed, cut to the site's limit, and the commit when there is none. */
const titleOf = (card: Card): string => cut(card.mergeTitle.trim(), MAX_TITLE) || card.merge;

/** A hash of everything the site is sent for this card, so a card changed since is sent again. */
export function cardHash(card: Card): string {
  return createHash("sha256").update(JSON.stringify([card.merge, titleOf(card), card.source, toSubmitted(card)])).digest("hex");
}

/** The plugin's card as the site's `submittedCard`: the merge, title and source go with the batch. */
export function toSubmitted(card: Card): SubmittedCard {
  const a = card.anchor;
  return {
    id: card.id,
    area: card.area,
    status: card.status,
    body: card.body,
    anchor: { commit: a.commit, path: a.path, symbol: a.symbol, startLine: a.startLine, endLine: a.endLine, fingerprint: a.fingerprint, status: a.status },
  };
}

const SHA = /^[0-9a-f]{7,64}$/;
const CARD_ID = /^[A-Za-z0-9._-]{1,120}$/;
const within = (s: string, min: number, max: number): boolean => s.length >= min && s.length <= max;

/**
 * Why the site's contract would refuse this card, or null when it fits. A card the site's schema refuses
 * would fail its whole batch, so such cards are held back and reported as rejected instead.
 */
export function unsendable(card: Card): string | null {
  const a = card.anchor;
  const b = card.body;
  if (!CARD_ID.test(card.id)) return "card id is too long for the site";
  if (!SHA.test(card.merge)) return "merge is not a commit id";
  if (card.area.length > 200) return "area is over 200 characters";
  if (!SHA.test(a.commit)) return "anchor commit is not a commit id";
  if (!within(a.path, 1, 500)) return "anchor path is empty or over 500 characters";
  if (a.symbol !== null && a.symbol.length > 200) return "anchor symbol is over 200 characters";
  if (!Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < 1) return "anchor lines must be positive";
  if (!within(a.fingerprint, 8, 128)) return "anchor fingerprint has the wrong length";
  if (b.kind === "mcq") {
    if (!within(b.question, 1, 1200)) return "question is empty or over 1200 characters";
    if (b.choices.length < 2 || b.choices.length > 6 || b.choices.some((c) => !within(c, 1, 400))) return "choices must be 2-6, each 1-400 characters";
    if (!within(b.explanation, 1, 1200)) return "explanation is empty or over 1200 characters";
  } else if (!within(b.front, 1, 1200) || !within(b.back, 1, 1200)) {
    return "front and back must each be 1-1200 characters";
  }
  return null;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function checkSubmitResult(v: unknown): SubmitCardsResult {
  const r = v as Partial<SubmitCardsResult> | null;
  const ok =
    r !== null && typeof r === "object" && isStrings(r.accepted) && isStrings(r.unchanged) && Array.isArray(r.rejected) &&
    r.rejected.every((x) => typeof x?.id === "string" && typeof x?.reason === "string");
  if (!ok) throw new RemoteError("submit_cards returned an unexpected result", "tool");
  return r as SubmitCardsResult;
}

export interface SubmitReport {
  /** Cards the site now holds as they are locally: accepted, or already there unchanged. */
  uploaded: number;
  /** Cards refused this time: held back, or rejected by the site. A card refused before, unchanged since, isn't sent or listed again. */
  rejected: Rejection[];
}

export interface SubmitOptions {
  /** Filled in as batches land, so a caller sees the progress made before a failure. */
  report?: SubmitReport;
  /** Stops before the next batch, and aborts the one in flight. */
  signal?: AbortSignal;
  /** Called after each batch: the caller's lock refresh, so a long upload doesn't let its lock go stale. */
  refresh?: () => void;
}

/** Thrown when a sync's time budget runs out. */
const outOfTime = (): RemoteError => new RemoteError("the site sync ran out of time", "network");

/**
 * Uploads the cards the site doesn't have as they are now, grouped by merge (and title, since baseline areas
 * share a commit) in batches of {@link BATCH_SIZE}. `state.submitted` and `state.refused` hold each card's
 * {@link cardHash} as sent: a card is sent again only when it changed (or has an old `true` mark). They are
 * saved after each batch, so a failure part way keeps what got through and the rest is retried next time.
 * The caller holds the repo's capture lock.
 */
export async function submitPending(key: string, remote: Remote, opts: SubmitOptions = {}): Promise<SubmitReport> {
  const report = opts.report ?? { uploaded: 0, rejected: [] };
  const state = readState(key);
  const submitted = (state.submitted ??= {});
  const refused = (state.refused ??= {});
  const groups = new Map<string, { card: Card; hash: string }[]>();
  let heldBack = false;
  for (const card of listCards(key)) {
    const hash = cardHash(card);
    if (submitted[card.id] === hash || refused[card.id] === hash) continue;
    const why = unsendable(card);
    if (why) {
      refused[card.id] = hash;
      report.rejected.push({ id: card.id, reason: why });
      heldBack = true;
      continue;
    }
    const group = JSON.stringify([card.merge, titleOf(card), card.source]);
    groups.set(group, [...(groups.get(group) ?? []), { card, hash }]);
  }
  if (heldBack) writeState(key, state);
  for (const entries of groups.values()) {
    const { card: first } = entries[0];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      if (opts.signal?.aborted) throw outOfTime();
      const batch = entries.slice(i, i + BATCH_SIZE);
      const input: SubmitCardsInput = {
        repo: key, merge: first.merge, mergeTitle: titleOf(first), source: first.source, cards: batch.map((e) => toSubmitted(e.card)),
      };
      const result = checkSubmitResult(await remote.call<unknown>("submit_cards", { ...input }, { signal: opts.signal }));
      const sent = new Map(batch.map((e) => [e.card.id, e.hash]));
      for (const id of new Set([...result.accepted, ...result.unchanged])) {
        const hash = sent.get(id);
        if (hash === undefined) continue;
        submitted[id] = hash;
        delete refused[id];
        report.uploaded++;
      }
      for (const r of result.rejected) {
        const hash = sent.get(r.id);
        if (hash === undefined) continue;
        refused[r.id] = hash;
        report.rejected.push(r);
      }
      writeState(key, state);
      opts.refresh?.();
    }
  }
  return report;
}

// ---- link and unlink. ----

export interface LinkOutput {
  repoId: string;
  deckId: string;
  uploaded: number;
  rejected: Rejection[];
}

export interface UnlinkOutput {
  /** The site the repo was linked to, or null when it wasn't linked. */
  unlinked: string | null;
}

export const BUSY = "busy, try again: a capture or baseline is running";

/**
 * Links the repo to the site (`link_repo`), saves the link in the config, and uploads every local card with
 * its status. Every card is sent again, so linking twice, or to another site, leaves the site with them all.
 */
export async function linkRepo(key: string, repoPath: string, site: string, remote: Remote, now: () => Date = () => new Date()): Promise<LinkOutput> {
  if (!REPO_KEY.test(key)) throw new Error("this repo's folder name is too long for the site: its key must be at most 80 characters");
  const lock = acquireLock(key);
  if (!lock) throw new Error(BUSY);
  try {
    const name = cut(path.basename(repoPath).trim(), MAX_NAME) || key;
    const linked = await remote.call<LinkRepoResult>("link_repo", { key, name });
    if (typeof linked?.repoId !== "string" || typeof linked?.deckId !== "string") throw new RemoteError("link_repo returned an unexpected result", "tool");
    const link: RemoteLink = { site, repoId: linked.repoId, deckId: linked.deckId, linkedAt: now().toISOString() };
    setRemote(key, link);
    const state = readState(key);
    delete state.submitted;
    delete state.refused;
    delete state.anchorsPushed;
    delete state.remoteAuth;
    writeState(key, state);
    const { uploaded, rejected } = await submitPending(key, remote, { refresh: lock.refresh });
    return { repoId: link.repoId, deckId: link.deckId, uploaded, rejected };
  } finally {
    lock.release();
  }
}

/** Forgets the repo's link. The site keeps its copy of the cards. */
export function unlinkRepo(key: string): UnlinkOutput {
  return { unlinked: setRemote(key, undefined)?.site ?? null };
}

// ---- Uploads during capture. ----

/** The site takes at most this many anchors per `update_anchors` call. */
export const ANCHOR_BATCH = 2000;

/** A card's anchor as `update_anchors` takes it. */
export interface AnchorPush {
  id: string;
  status: AnchorStatus;
  startLine: number;
  endLine: number;
}

/** How long one capture's site sync may take in all, connecting included. */
export const SYNC_BUDGET_MS = 90_000;

export interface SiteSyncOptions {
  connect?: (site: string) => Promise<Remote>;
  /**
   * Capture's anchor recheck, by card id. With it, every submitted card that isn't dropped locally has its
   * anchor pushed (`update_anchors`): the recheck's result, else the card file's anchor. Pushed only when the
   * set changed since the last push, or cards were uploaded.
   */
  anchors?: Map<string, AnchorPush>;
  /** The caller's lock refresh, called as the sync makes progress. */
  refresh?: () => void;
  /** Overrides {@link SYNC_BUDGET_MS}, for tests. */
  budgetMs?: number;
}

/** What capture.log says about a failure: its kind and a fixed message, never the error's text, tokens or card text. */
function failureLine(kind: string, step: string, timedOut: boolean): string {
  if (timedOut) return `site sync failed (network): timed out during ${step}`;
  if (kind === "auth") return `site sync failed (auth): the site refused the sign-in or it expired; run repobrain login`;
  if (kind === "network") return `site sync failed (network): could not reach the site during ${step}`;
  return `site sync failed (tool): ${step} failed`;
}

function setRemoteAuth(key: string, expired: boolean): void {
  const state = readState(key);
  if (expired === (state.remoteAuth === "expired")) return;
  if (expired) state.remoteAuth = "expired";
  else delete state.remoteAuth;
  writeState(key, state);
}

/** `p`, or a rejection when `signal` aborts first; a Remote that connects after that is closed. */
function untilAborted(p: Promise<Remote>, signal: AbortSignal): Promise<Remote> {
  p.then((r) => (signal.aborted ? r.close().catch(() => {}) : undefined), () => {});
  return new Promise<Remote>((resolve, reject) => {
    if (signal.aborted) return reject(outOfTime());
    const onAbort = () => reject(outOfTime());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (r) => (signal.removeEventListener("abort", onAbort), resolve(r)),
      (e: unknown) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pushes the anchors of the submitted cards that aren't dropped locally, when they changed since the last push. */
async function pushAnchors(key: string, remote: Remote, rechecked: Map<string, AnchorPush>, uploaded: number, signal: AbortSignal, refresh?: () => void): Promise<void> {
  const submitted = readState(key).submitted ?? {};
  const anchors: AnchorPush[] = listCards(key)
    .filter((c) => c.status !== "dropped" && submitted[c.id] !== undefined && CARD_ID.test(c.id))
    .map((c) => rechecked.get(c.id) ?? { id: c.id, status: c.anchor.status, startLine: c.anchor.startLine, endLine: c.anchor.endLine });
  const hash = sha256(anchors);
  if (hash === readState(key).anchorsPushed && uploaded === 0) return;
  for (let i = 0; i < anchors.length; i += ANCHOR_BATCH) {
    if (signal.aborted) throw outOfTime();
    await remote.call("update_anchors", { repo: key, anchors: anchors.slice(i, i + ANCHOR_BATCH) }, { signal });
    refresh?.();
  }
  const state = readState(key);
  state.anchorsPushed = hash;
  writeState(key, state);
}

/**
 * When the repo is linked, uploads the cards the site doesn't have and, with `anchors`, pushes anchors.
 * Best effort, within one time budget: a failure is logged to capture.log by kind only and never thrown,
 * and an auth failure sets `state.remoteAuth` until the site next accepts the sign-in. Returns how many cards
 * the site took. The caller holds the repo's capture lock.
 */
export async function syncToSite(key: string, opts: SiteSyncOptions = {}): Promise<number> {
  const report: SubmitReport = { uploaded: 0, rejected: [] };
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), opts.budgetMs ?? SYNC_BUDGET_MS);
  timer.unref();
  const signal = budget.signal;
  let step = "connect";
  try {
    const link = loadConfig().repos[key]?.remote;
    if (!link) return 0;
    if (!isSignedIn(link.site)) throw new RemoteError("not signed in", "auth");
    const remote = await untilAborted((opts.connect ?? connectRemote)(link.site), signal);
    try {
      // Connecting sends the stored token, so the site has accepted the sign-in.
      setRemoteAuth(key, false);
      step = "submit_cards";
      await submitPending(key, remote, { report, signal, refresh: opts.refresh });
      if (opts.anchors) {
        step = "update_anchors";
        await pushAnchors(key, remote, opts.anchors, report.uploaded, signal, opts.refresh);
      }
    } finally {
      await remote.close().catch(() => {});
    }
    if (report.uploaded || report.rejected.length) {
      appendLog(key, `site: ${report.uploaded} cards uploaded${report.rejected.length ? `, ${report.rejected.length} refused: ${report.rejected.map((r) => r.id).join(" ")}` : ""}`);
    }
  } catch (e) {
    const kind = e instanceof RemoteError ? e.kind : "tool";
    try {
      appendLog(key, failureLine(kind, step, signal.aborted) + (report.uploaded ? ` (${report.uploaded} cards uploaded first)` : ""));
      if (kind === "auth" && !signal.aborted) setRemoteAuth(key, true);
    } catch {
      // An unwritable state or log: the capture itself still stands.
    }
  } finally {
    clearTimeout(timer);
  }
  return report.uploaded;
}
