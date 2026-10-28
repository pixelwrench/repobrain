import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepo } from "./store.js";

/** bin.js beside this module: dist/bin.js when built. */
const defaultBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin.js");

/**
 * Starts `codebrain capture` in the background for a connected repo and returns at once.
 * It checks the connection itself so that sessions in unconnected repos never write logs.
 * CODEBRAIN_CAPTURE stops the capture's own `claude -p` session from starting another capture.
 * Never throws: a hook must not break the session.
 */
export function startCapture(cwd: string, bin = defaultBin): boolean {
  try {
    if (process.env.CODEBRAIN_CAPTURE) return false;
    if (!findRepo(cwd)) return false;
    const child = spawn(process.execPath, [bin, "capture", "--repo", cwd], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODEBRAIN_CAPTURE: "1" },
    });
    child.on("error", () => {}); // a failed spawn is emitted async; don't let it crash the hook
    child.unref();
    return true;
  } catch {
    return false;
  }
}
