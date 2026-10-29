var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/format.ts
var init_format = __esm({
  "src/format.ts"() {
    "use strict";
  }
});

// src/git.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" }
  });
}
function tryGit(repo, args, options) {
  try {
    return git(repo, args, options).trim();
  } catch {
    return null;
  }
}
function repoRoots(dir, options) {
  const out = tryGit(dir, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], options);
  const [top, common] = out?.split("\n") ?? [];
  if (!top) return null;
  if (!common || path.basename(common) !== ".git") return { top, main: top };
  let main = path.dirname(common);
  try {
    main = fs.realpathSync(main);
  } catch {
    return { top, main: top };
  }
  return { top, main };
}
var init_git = __esm({
  "src/git.ts"() {
    "use strict";
  }
});

// src/store.ts
import { createHash, randomUUID } from "node:crypto";
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
function checkId(kind, id) {
  if (!SAFE_ID.test(id)) throw new Error(`repobrain: invalid ${kind} ${JSON.stringify(id)}`);
  return id;
}
function home() {
  return process.env.REPOBRAIN_HOME ?? path2.join(os.homedir(), ".repobrain");
}
function readJson(file, fallback) {
  let text;
  try {
    text = fs2.readFileSync(file, "utf8");
  } catch (e) {
    if (isEnoent(e)) return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`repobrain: ${file} is not valid JSON; fix or delete it`);
  }
}
function loadConfig() {
  const file = configPath();
  const raw = readJson(file, {});
  if (!isObject(raw) || raw.repos !== void 0 && !isObject(raw.repos)) {
    throw new Error(`repobrain: ${file} is not a valid config; fix or delete it`);
  }
  return { ...raw, repos: raw.repos ?? {} };
}
function repoKey(absPath) {
  const name = path2.basename(absPath).replace(/[^A-Za-z0-9._-]/g, "_");
  const safe = /^[A-Za-z0-9]/.test(name) ? name : `repo${name}`;
  return `${safe}-${createHash("sha256").update(absPath).digest("hex").slice(0, 6)}`;
}
function findRepo(dir, options, config = loadConfig()) {
  const roots = repoRoots(dir, options);
  if (!roots) return null;
  for (const root of /* @__PURE__ */ new Set([roots.top, roots.main])) {
    const key = repoKey(root);
    const repo = config.repos[key];
    if (repo) return { key, config: repo };
  }
  return null;
}
function appendLog(key, line) {
  fs2.mkdirSync(repoDir(key), { recursive: true });
  fs2.appendFileSync(path2.join(repoDir(key), "capture.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
}
var SAFE_ID, isEnoent, configPath, repoDir, isObject;
var init_store = __esm({
  "src/store.ts"() {
    "use strict";
    init_format();
    init_git();
    SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    isEnoent = (e) => e.code === "ENOENT";
    configPath = () => path2.join(home(), "config.json");
    repoDir = (key) => path2.join(home(), "repos", checkId("repo key", key));
    isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  }
});

// src/hook.ts
var hook_exports = {};
__export(hook_exports, {
  startCapture: () => startCapture
});
import { spawn } from "node:child_process";
import fs3 from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";
function treesOf(repoPath) {
  const trees = [repoPath];
  try {
    const dir = path3.join(repoPath, ".git", "worktrees");
    for (const name of fs3.readdirSync(dir)) {
      try {
        const gitFile = fs3.readFileSync(path3.join(dir, name, "gitdir"), "utf8").trim();
        if (gitFile) trees.push(fs3.realpathSync(path3.dirname(gitFile)));
      } catch {
      }
    }
  } catch {
  }
  return trees;
}
function openErrorLog() {
  try {
    fs3.mkdirSync(home(), { recursive: true });
    return fs3.openSync(path3.join(home(), "capture-errors.log"), "a");
  } catch {
    return null;
  }
}
function startCapture(cwd, bin = defaultBin) {
  try {
    if (process.env.REPOBRAIN_CAPTURE) return false;
    const config = loadConfig();
    const repos = Object.values(config.repos);
    if (repos.length === 0) return false;
    const real = fs3.realpathSync(cwd);
    if (!repos.some((r) => treesOf(r.path).some((t) => isWithin(real, t)))) return false;
    const found = findRepo(real, { timeoutMs: GIT_TIMEOUT_MS }, config);
    if (!found) return false;
    if (!fs3.existsSync(bin)) {
      appendLog(found.key, `repobrain bin missing at ${bin}; rebuild or reinstall`);
      return false;
    }
    const errFd = openErrorLog();
    try {
      const child = spawn(process.execPath, [bin, "capture", "--repo", found.config.path], {
        detached: true,
        stdio: ["ignore", "ignore", errFd ?? "ignore"],
        env: { ...process.env, REPOBRAIN_CAPTURE: "1" }
      });
      child.on("error", () => {
      });
      child.unref();
    } finally {
      if (errFd !== null) {
        try {
          fs3.closeSync(errFd);
        } catch {
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
var defaultBin, GIT_TIMEOUT_MS, isWithin;
var init_hook = __esm({
  "src/hook.ts"() {
    "use strict";
    init_store();
    defaultBin = path3.join(path3.dirname(fileURLToPath(import.meta.url)), "bin.js");
    GIT_TIMEOUT_MS = 1500;
    isWithin = (dir, root) => dir === root || dir.startsWith(root.endsWith(path3.sep) ? root : root + path3.sep);
  }
});

// src/hook-bin.ts
var STDIN_TIMEOUT_MS = 500;
var input = "";
var finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    let cwd;
    try {
      cwd = JSON.parse(input || "{}")?.cwd;
    } catch {
    }
    const { startCapture: startCapture2 } = await Promise.resolve().then(() => (init_hook(), hook_exports));
    startCapture2(typeof cwd === "string" && cwd ? cwd : process.cwd());
  } catch {
  } finally {
    process.exit(0);
  }
}
var timer = setTimeout(finish, STDIN_TIMEOUT_MS);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => input += d);
process.stdin.on("end", finish);
process.stdin.on("error", finish);
