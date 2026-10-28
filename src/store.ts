import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCard, serializeCard, type Card } from "./format.js";
import { toplevel } from "./git.js";

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
}

export function home(): string {
  return process.env.CODEBRAIN_HOME ?? path.join(os.homedir(), ".codebrain");
}
const configPath = (): string => path.join(home(), "config.json");
export const repoDir = (key: string): string => path.join(home(), "repos", key);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function loadConfig(): Config {
  return readJson<Config>(configPath(), { repos: {} });
}

export function repoKey(absPath: string): string {
  return `${path.basename(absPath)}-${createHash("sha256").update(absPath).digest("hex").slice(0, 6)}`;
}

export function connectRepo(dir: string, areaDepth = 3): string {
  const top = toplevel(dir);
  if (!top) throw new Error(`${dir} is not inside a git repository`);
  const config = loadConfig();
  const key = repoKey(top);
  config.repos[key] = { path: top, areaDepth };
  writeJson(configPath(), config);
  fs.mkdirSync(path.join(repoDir(key), "cards"), { recursive: true });
  return key;
}

export function findRepo(dir: string): { key: string; config: RepoConfig } | null {
  const top = toplevel(dir);
  if (!top) return null;
  const key = repoKey(top);
  const config = loadConfig().repos[key];
  return config ? { key, config } : null;
}

export function readState(key: string): RepoState {
  return readJson<RepoState>(path.join(repoDir(key), "state.json"), { lastSha: null, updatedAt: null });
}

export function writeState(key: string, state: RepoState): void {
  writeJson(path.join(repoDir(key), "state.json"), state);
}

export const cardPath = (key: string, id: string): string => path.join(repoDir(key), "cards", `${id}.md`);

export function writeCard(key: string, card: Card): void {
  const file = cardPath(key, card.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeCard(card));
}

export function readCard(key: string, id: string): Card {
  return parseCard(fs.readFileSync(cardPath(key, id), "utf8"));
}

export function listCards(key: string): Card[] {
  const dir = path.join(repoDir(key), "cards");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => {
      try {
        return [parseCard(fs.readFileSync(path.join(dir, f), "utf8"))];
      } catch (e) {
        console.error(`codebrain: skipping ${f}: ${(e as Error).message}`);
        return [];
      }
    });
}

/** Returns a release function, or null if another capture holds a fresh lock. */
export function acquireLock(key: string, staleMs = 15 * 60_000): (() => void) | null {
  const file = path.join(repoDir(key), "capture.lock");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        // removed between the write and the stat: retry
      }
      if (age < staleMs) return null;
      fs.rmSync(file, { force: true });
    }
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
  try {
    return fs
      .readFileSync(path.join(repoDir(key), file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}
