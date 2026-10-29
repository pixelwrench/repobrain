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
  /** Cards the site now holds: accepted, or already there unchanged. */
  uploaded: number;
  rejected: Rejection[];
}

/**
 * Uploads the cards the site doesn't have yet, grouped by merge (and title, since baseline areas share a
 * commit) in batches of {@link BATCH_SIZE}. `state.submitted` is saved after each batch, so a failure part way
 * keeps what got through and the rest is retried next time. Rejected cards are not marked, so they're sent again.
 * The caller holds the repo's capture lock. `report` is filled in as batches land, so a caller sees the
 * progress made before a failure.
 */
export async function submitPending(key: string, remote: Remote, report: SubmitReport = { uploaded: 0, rejected: [] }): Promise<SubmitReport> {
  const state = readState(key);
  const submitted = (state.submitted ??= {});
  const groups = new Map<string, Card[]>();
  for (const card of listCards(key)) {
    if (submitted[card.id]) continue;
    const why = unsendable(card);
    if (why) {
      report.rejected.push({ id: card.id, reason: why });
      continue;
    }
    const group = JSON.stringify([card.merge, card.mergeTitle, card.source]);
    groups.set(group, [...(groups.get(group) ?? []), card]);
  }
  for (const cards of groups.values()) {
    const { merge, mergeTitle, source } = cards[0];
    for (let i = 0; i < cards.length; i += BATCH_SIZE) {
      const batch = cards.slice(i, i + BATCH_SIZE);
      const input: SubmitCardsInput = {
        repo: key, merge, mergeTitle: mergeTitle.trim().slice(0, MAX_TITLE) || merge, source, cards: batch.map(toSubmitted),
      };
      const result = checkSubmitResult(await remote.call<unknown>("submit_cards", { ...input }));
      const sent = new Set(batch.map((c) => c.id));
      for (const id of [...result.accepted, ...result.unchanged]) {
        if (!sent.has(id) || submitted[id]) continue;
        submitted[id] = true;
        report.uploaded++;
      }
      report.rejected.push(...result.rejected.filter((r) => sent.has(r.id)));
      writeState(key, state);
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
  const lock = acquireLock(key);
  if (!lock) throw new Error(BUSY);
  try {
    const name = path.basename(repoPath).trim().slice(0, MAX_NAME) || key;
    const linked = await remote.call<LinkRepoResult>("link_repo", { key, name });
    if (typeof linked?.repoId !== "string" || typeof linked?.deckId !== "string") throw new RemoteError("link_repo returned an unexpected result", "tool");
    const link: RemoteLink = { site, repoId: linked.repoId, deckId: linked.deckId, linkedAt: now().toISOString() };
    setRemote(key, link);
    const state = readState(key);
    delete state.submitted;
    delete state.remoteAuth;
    writeState(key, state);
    const { uploaded, rejected } = await submitPending(key, remote);
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

export interface SiteSyncOptions {
  connect?: (site: string) => Promise<Remote>;
  /** Also push every kept card's anchor status and lines (`update_anchors`), after capture's anchor recheck. */
  anchors?: boolean;
}

/** What capture.log says about a failure: its kind and a fixed message, never the error's text, tokens or card text. */
function failureLine(kind: string, step: string): string {
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

/**
 * When the repo is linked, uploads the cards the site doesn't have and, with `anchors`, pushes the kept
 * cards' anchors. Best effort: a failure is logged to capture.log by kind only and never thrown, and an auth
 * failure sets `state.remoteAuth` until an upload succeeds. Returns how many cards the site took.
 * The caller holds the repo's capture lock.
 */
export async function syncToSite(key: string, opts: SiteSyncOptions = {}): Promise<number> {
  const report: SubmitReport = { uploaded: 0, rejected: [] };
  let step = "connect";
  try {
    const link = loadConfig().repos[key]?.remote;
    if (!link) return 0;
    if (!isSignedIn(link.site)) throw new RemoteError("not signed in", "auth");
    const remote = await (opts.connect ?? connectRemote)(link.site);
    try {
      step = "submit_cards";
      await submitPending(key, remote, report);
      if (opts.anchors) {
        step = "update_anchors";
        const anchors = listCards(key)
          .filter((c) => c.status === "kept")
          .map((c) => ({ id: c.id, status: c.anchor.status, startLine: c.anchor.startLine, endLine: c.anchor.endLine }));
        for (let i = 0; i < anchors.length; i += ANCHOR_BATCH) {
          await remote.call("update_anchors", { repo: key, anchors: anchors.slice(i, i + ANCHOR_BATCH) });
        }
      }
    } finally {
      await remote.close().catch(() => {});
    }
    setRemoteAuth(key, false);
    if (report.uploaded || report.rejected.length) {
      appendLog(key, `site: ${report.uploaded} cards uploaded${report.rejected.length ? `, ${report.rejected.length} refused: ${report.rejected.map((r) => r.id).join(" ")}` : ""}`);
    }
  } catch (e) {
    const kind = e instanceof RemoteError ? e.kind : "tool";
    try {
      appendLog(key, failureLine(kind, step) + (report.uploaded ? ` (${report.uploaded} cards uploaded first)` : ""));
      if (kind === "auth") setRemoteAuth(key, true);
    } catch {
      // An unwritable state or log: the capture itself still stands.
    }
  }
  return report.uploaded;
}
