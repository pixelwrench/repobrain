import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCard, serializeCard, type Card } from "./format.js";
import { repoRoots, type GitOptions } from "./git.js";

export interface RepoConfig {
  path: string;
  areaDepth: number;
}
export interface Config {
  repos: Record<string, RepoConfig>;
}
export interface RepoState {
  lastSha: string | null;
  updatedAt: string | null;
  /** Consecutive failures drafting one merge; capture gives up on it after a few. */
  failures?: { sha: string; count: number };
  /** The most recent merges fully handled (cards written or skipped), newest last. Missing in old state files. */
  processed?: string[];
  /**
   * The latest environment failure (claude missing, logged out, offline, rate-limited), from when
   * it began. Capture sets it and any successful claude call clears it; week and stats show it.
   */
  unavailable?: { since: string; message: string };
  /** The last unexpected capture failure (a git error, say); a run that completes clears it. Week and stats show it. */
  lastError?: { at: string; message: string };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `id` is a safe card or repo id: no path separators, no leading dot. */
export const isSafeId = (id: string): boolean => SAFE_ID.test(id);

function checkId(kind: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`repobrain: invalid ${kind} ${JSON.stringify(id)}`);
  return id;
}

const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";

export function home(): string {
  return process.env.REPOBRAIN_HOME ?? path.join(os.homedir(), ".repobrain");
}
const configPath = (): string => path.join(home(), "config.json");
export const repoDir = (key: string): string => path.join(home(), "repos", checkId("repo key", key));

/** Parses a JSON file; returns fallback only when the file is missing, and throws a clear error on corrupt JSON. */
export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isEnoent(e)) return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`repobrain: ${file} is not valid JSON; fix or delete it`);
  }
}

/** Writes via a temp file in the same directory, then renames over the target. `mode` sets the new file's permissions. */
export function writeFileAtomic(file: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadConfig(): Config {
  const file = configPath();
  const raw = readJson<unknown>(file, {});
  if (!isObject(raw) || (raw.repos !== undefined && !isObject(raw.repos))) {
    throw new Error(`repobrain: ${file} is not a valid config; fix or delete it`);
  }
  return { ...raw, repos: (raw.repos ?? {}) as Record<string, RepoConfig> };
}

export function repoKey(absPath: string): string {
  const name = path.basename(absPath).replace(/[^A-Za-z0-9._-]/g, "_");
  const safe = /^[A-Za-z0-9]/.test(name) ? name : `repo${name}`;
  return `${safe}-${createHash("sha256").update(absPath).digest("hex").slice(0, 6)}`;
}

/** Connects the repo `dir` is in; from a linked worktree, that's the main repo, so every worktree shares its cards. */
export function connectRepo(dir: string, areaDepth = 3): string {
  const roots = repoRoots(dir);
  if (!roots) throw new Error(`${dir} is not inside a git repository`);
  const top = roots.main;
  const config = loadConfig();
  const key = repoKey(top);
  config.repos[key] = { path: top, areaDepth };
  writeJson(configPath(), config);
  fs.mkdirSync(path.join(repoDir(key), "cards"), { recursive: true });
  return key;
}

/**
 * The connected repo `dir` belongs to: its own working tree, or, from a linked worktree, the main repo.
 * Pass `config` when it's already loaded, and `options` to bound the git call.
 */
export function findRepo(dir: string, options?: GitOptions, config: Config = loadConfig()): { key: string; config: RepoConfig } | null {
  const roots = repoRoots(dir, options);
  if (!roots) return null;
  for (const root of new Set([roots.top, roots.main])) {
    const key = repoKey(root);
    const repo = config.repos[key];
    if (repo) return { key, config: repo };
  }
  return null;
}

export function readState(key: string): RepoState {
  return readJson<RepoState>(path.join(repoDir(key), "state.json"), { lastSha: null, updatedAt: null });
}

export function writeState(key: string, state: RepoState): void {
  writeJson(path.join(repoDir(key), "state.json"), state);
}

export const cardPath = (key: string, id: string): string => path.join(repoDir(key), "cards", `${checkId("card id", id)}.md`);

export function writeCard(key: string, card: Card): void {
  writeFileAtomic(cardPath(key, card.id), serializeCard(card));
}

export function readCard(key: string, id: string): Card {
  const card = parseCard(fs.readFileSync(cardPath(key, id), "utf8"));
  if (card.id !== id) throw new Error(`repobrain: card file ${id}.md holds card ${JSON.stringify(card.id)}`);
  return card;
}

/**
 * Whether writing this drafted card is safe. A card file that exists and isn't a draft
 * (or can't be read) holds the user's curation, which a retry must never replace.
 */
export function mayWriteDraft(key: string, id: string): boolean {
  if (!fs.existsSync(cardPath(key, id))) return true;
  try {
    return readCard(key, id).status === "draft";
  } catch {
    return false;
  }
}

export interface CardListing {
  cards: Card[];
  /** Card files that couldn't be read (a broken edit, say), with why. `file` is the absolute path. */
  unreadable: { file: string; error: string }[];
}

/** Every card file, split into the readable cards and the files that couldn't be read. */
export function listCardsReport(key: string): CardListing {
  const dir = path.join(repoDir(key), "cards");
  const listing: CardListing = { cards: [], unreadable: [] };
  if (!fs.existsSync(dir)) return listing;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const file = path.join(dir, f);
    try {
      const card = parseCard(fs.readFileSync(file, "utf8"));
      if (!SAFE_ID.test(card.id) || `${card.id}.md` !== f) {
        throw new Error(`card id ${JSON.stringify(card.id)} is unsafe or doesn't match its file name`);
      }
      listing.cards.push(card);
    } catch (e) {
      listing.unreadable.push({ file, error: (e as Error).message });
    }
  }
  return listing;
}

/** The readable cards; each unreadable file is skipped with a warning on stderr. */
export function listCards(key: string): Card[] {
  const { cards, unreadable } = listCardsReport(key);
  for (const u of unreadable) console.error(`repobrain: skipping ${path.basename(u.file)}: ${u.error}`);
  return cards;
}

export interface Lock {
  /** Deletes the lock file, but only if it still holds this lock's token. */
  release(): void;
  /** Touches the lock's mtime so it doesn't go stale; a no-op if the lock is no longer ours. */
  refresh(): void;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the per-repo capture lock. Returns null if another live process holds a lock
 * newer than staleMs. A lock whose holder pid is dead, or that is older than staleMs, is reclaimed.
 */
export function acquireLock(key: string, staleMs = 15 * 60_000): Lock | null {
  return acquireFileLock(path.join(repoDir(key), "capture.lock"), staleMs);
}

/** Takes the lock at `file`, with the same rules as {@link acquireLock}. */
export function acquireFileLock(file: string, staleMs: number): Lock | null {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const ours = (): boolean => readOrNull(file) === token;
  const lock: Lock = {
    release: () => {
      if (ours()) fs.rmSync(file, { force: true });
    },
    refresh: () => {
      if (!ours()) return;
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch (e) {
        if (!isEnoent(e)) throw e; // released or reclaimed meanwhile
      }
    },
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(file, token, { flag: "wx" });
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held: string;
    let mtimeMs: number;
    try {
      held = fs.readFileSync(file, "utf8");
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) {
      if (isEnoent(e)) continue; // released meanwhile: retry wx
      throw e;
    }
    const pid = Number.parseInt(held.split(":")[0] ?? "", 10);
    // An unreadable pid (e.g. a holder mid-write) counts as alive; only age can reclaim it.
    const alive = Number.isNaN(pid) || pidAlive(pid);
    if (alive && Date.now() - mtimeMs < staleMs) return null;

    // Rename is atomic, so only one reclaimer moves the stale lock aside.
    const aside = `${file}.${process.pid}.${randomUUID()}.stale`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if (isEnoent(e)) continue; // another reclaimer won: retry wx
      throw e;
    }
    // If a new holder replaced the lock between our read and rename, put theirs back.
    if (fs.readFileSync(aside, "utf8") !== held) {
      try {
        fs.linkSync(aside, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      fs.rmSync(aside, { force: true });
      return null;
    }
    fs.rmSync(aside, { force: true });
  }
  return null;
}

export function appendLog(key: string, line: string): void {
  fs.mkdirSync(repoDir(key), { recursive: true });
  fs.appendFileSync(path.join(repoDir(key), "capture.log"), `${new Date().toISOString()} ${line}\n`);
}

export function appendJsonl(key: string, file: string, value: unknown): void {
  fs.mkdirSync(repoDir(key), { recursive: true });
  fs.appendFileSync(path.join(repoDir(key), file), JSON.stringify(value) + "\n");
}

export function readJsonl<T = unknown>(key: string, file: string): T[] {
  const text = readOrNull(path.join(repoDir(key), file));
  if (text === null) return [];
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}
