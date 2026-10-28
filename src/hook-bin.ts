// Claude Code SessionStart hook. Fails open: it never blocks or breaks a session.
import { startCapture } from "./hook.js";

/** How long to wait for the hook's JSON input before falling back to process.cwd(). */
const STDIN_TIMEOUT_MS = 500;

let input = "";
let finished = false;

function finish(): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    let cwd: unknown;
    try {
      cwd = (JSON.parse(input || "{}") as { cwd?: unknown } | null)?.cwd;
    } catch {
      // malformed input: fall back to process.cwd()
    }
    startCapture(typeof cwd === "string" && cwd ? cwd : process.cwd());
  } catch {
    // fail open
  }
  process.exit(0);
}

const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => (input += d));
process.stdin.on("end", finish);
process.stdin.on("error", finish);
