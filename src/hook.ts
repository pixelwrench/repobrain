import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLog, findRepo, home, loadConfig } from "./store.js";

/** bin.js beside this module: dist/bin.js when built. */
const defaultBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin.js");
/** The hook's only git call is killed after this long, well inside the hook's 5s timeout. */
const GIT_TIMEOUT_MS = 1500;

/** A connected repo's own path plus its linked worktrees' paths, read from `<repo>/.git/worktrees/*\/gitdir` without git. */
function treesOf(repoPath: string): string[] {
  const trees = [repoPath];
  try {
    const dir = path.join(repoPath, ".git", "worktrees");
    for (const name of fs.readdirSync(dir)) {
      try {
        // gitdir holds the path to the worktree's `.git` file.
        const gitFile = fs.readFileSync(path.join(dir, name, "gitdir"), "utf8").trim();
        if (gitFile) trees.push(fs.realpathSync(path.dirname(gitFile)));
      } catch {
        // a pruned or half-made worktree
      }
    }
  } catch {
    // no linked worktrees
  }
  return trees;
}

/** `<REPOBRAIN_HOME>/capture-errors.log` opened for append, or null when it can't be. */
function openErrorLog(): number | null {
  try {
    fs.mkdirSync(home(), { recursive: true });
    return fs.openSync(path.join(home(), "capture-errors.log"), "a");
  } catch {
    return null;
  }
}

const isWithin = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Starts `repobrain capture` in the background for a connected repo and returns at once.
 * It reads the config first and calls git only when `cwd` is inside a connected repo or one of
 * its worktrees, with a timeout, so sessions elsewhere cost a file read and never write logs.
 * REPOBRAIN_CAPTURE stops the capture's own `claude -p` session from starting another capture.
 * Never throws: a hook must not break the session.
 */
export function startCapture(cwd: string, bin = defaultBin): boolean {
  try {
    if (process.env.REPOBRAIN_CAPTURE) return false;
    const config = loadConfig();
    const repos = Object.values(config.repos);
    if (repos.length === 0) return false;
    const real = fs.realpathSync(cwd);
    if (!repos.some((r) => treesOf(r.path).some((t) => isWithin(real, t)))) return false;
    const found = findRepo(real, { timeoutMs: GIT_TIMEOUT_MS }, config);
    if (!found) return false;
    if (!fs.existsSync(bin)) {
      appendLog(found.key, `repobrain bin missing at ${bin}; rebuild or reinstall`);
      return false;
    }
    // The child's stderr goes to capture-errors.log, so a capture that dies before it can log
    // (a broken install, a failed import) still leaves a trace.
    const errFd = openErrorLog();
    try {
      const child = spawn(process.execPath, [bin, "capture", "--repo", found.config.path], {
        detached: true,
        stdio: ["ignore", "ignore", errFd ?? "ignore"],
        env: { ...process.env, REPOBRAIN_CAPTURE: "1" },
      });
      child.on("error", () => {}); // a failed spawn is emitted async; don't let it crash the hook
      child.unref();
    } finally {
      if (errFd !== null) {
        try {
          fs.closeSync(errFd); // the child has its own copy
        } catch {
          // already closed
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
