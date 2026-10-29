/**
 * What is never sent to the model, shared by capture's diffs and the baseline's file list:
 * the default exclusions plus `.codebrain/ignore`, as git glob pathspecs.
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";

/** Glob pathspecs never sent to the model. `.codebrain/ignore` in the repo adds more, one per line. */
export const DEFAULT_EXCLUDES = [
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/*.lock", "**/*.min.js", "**/*.map",
  "**/*.snap", "**/dist/**", "**/build/**", "**/vendor/**", "**/node_modules/**", "**/.env*", "**/*.pem", "**/*.key",
];

/**
 * `.codebrain/ignore` as git pathspec globs. A leading `/` (gitignore's "from the root") is
 * stripped, since pathspecs are already relative to the root. Lines git would reject or read as
 * something else are dropped, each reported through `drop`: `!` negation, `:` pathspec magic,
 * any `..` segment, and anything else git refuses as an exclude pathspec (checked once per run).
 */
function readIgnore(repoPath: string, drop: (line: string, why: string) => void): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoPath, ".codebrain", "ignore"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return [];
    if (line.startsWith("!") || line.startsWith(":")) {
      drop(line, "negation and pathspec magic aren't supported");
      return [];
    }
    const glob = line.replace(/^\/+/, "");
    if (!glob) return [];
    if (glob.split("/").includes("..")) {
      drop(line, "a .. segment would reach outside the repository");
      return [];
    }
    const problem = pathspecProblem(repoPath, glob);
    if (problem !== null) {
      drop(line, `git rejects it: ${problem}`);
      return [];
    }
    return [glob];
  });
}

/** Paired with an exclude so ls-files has a positive pathspec that matches nothing, and prints nothing. */
const NO_MATCH = ":(literal).codebrain/no-such-file-pathspec-check";

/** Why git rejects `glob` as an exclude pathspec, or null when it takes it. */
function pathspecProblem(repoPath: string, glob: string): string | null {
  try {
    git(repoPath, ["ls-files", "--", NO_MATCH, `:(exclude,glob)${glob}`], { timeoutMs: 5_000 });
    return null;
  } catch (e) {
    const err = e as { stderr?: unknown };
    const detail = typeof err.stderr === "string" && err.stderr.trim() ? err.stderr.trim() : message(e);
    return detail.split("\n")[0]!.slice(0, 200);
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The default exclusions plus the repo's `.codebrain/ignore` lines; each line dropped is reported through `drop`. */
export function repoExcludes(repoPath: string, drop: (line: string, why: string) => void): string[] {
  return [...DEFAULT_EXCLUDES, ...readIgnore(repoPath, drop)];
}
