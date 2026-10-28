import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

export function makeRepo(): string {
  const dir = tempDir("codebrain-repo-");
  sh(dir, ["init", "-q", "-b", "master"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Test"]);
  sh(dir, ["config", "commit.gpgsign", "false"]);
  sh(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

/** Writes (or, with null, deletes) files, commits them all, and returns the new commit's SHA. */
export function commit(dir: string, files: Record<string, string | null>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    const p = path.join(dir, file);
    if (content === null) fs.rmSync(p, { force: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-q", "-m", message]);
  return sh(dir, ["rev-parse", "HEAD"]);
}

/** Points CODEBRAIN_HOME at a fresh temp dir for this test. */
export function useTempHome(): string {
  const home = tempDir("codebrain-home-");
  process.env.CODEBRAIN_HOME = home;
  return home;
}
