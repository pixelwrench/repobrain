import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startCapture } from "../src/hook.js";
import { connectRepo, repoDir } from "../src/store.js";
import { commit, makeRepo, sh, tempDir, useTempHome } from "./helpers.js";

/** A stand-in for bin.js that records how it was called. */
function fakeBin(marker: string): string {
  const file = path.join(tempDir("repobrain-bin-"), "bin.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.REPOBRAIN_CAPTURE }));`,
  );
  return file;
}

async function waitFor(file: string, ms = 10_000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text) return text;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitUntil(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Runs a built hook-bin.js as Claude Code would, with `input` on stdin. */
function runHook(hookBin: string, input: string, env: NodeJS.ProcessEnv) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [hookBin], { input, env, encoding: "utf8", timeout: 15_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

describe("startCapture", () => {
  let repo: string;
  let home: string;
  beforeEach(() => {
    delete process.env.REPOBRAIN_CAPTURE;
    home = useTempHome();
    repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
  });
  afterEach(() => {
    delete process.env.REPOBRAIN_CAPTURE;
  });

  it("does nothing in a repo that isn't connected, and writes no logs", async () => {
    const marker = path.join(tempDir("m-"), "x");
    expect(startCapture(repo, fakeBin(marker))).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("does nothing outside a git repo", () => {
    expect(startCapture(tempDir("plain-"), fakeBin(path.join(tempDir("m-"), "x")))).toBe(false);
  });

  it("does nothing inside a capture's own claude session", () => {
    connectRepo(repo);
    process.env.REPOBRAIN_CAPTURE = "1";
    expect(startCapture(repo, fakeBin(path.join(tempDir("m-"), "x")))).toBe(false);
  });

  it("starts a detached capture with the recursion guard set", async () => {
    connectRepo(repo);
    const marker = path.join(tempDir("m-"), "called.json");
    expect(startCapture(repo, fakeBin(marker))).toBe(true);
    expect(JSON.parse(await waitFor(marker))).toEqual({ argv: ["capture", "--repo", repo], env: "1" });
  });

  it("passes the main repo's path when the session is in a linked worktree", async () => {
    connectRepo(repo);
    const wt = path.join(tempDir("repobrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const marker = path.join(tempDir("m-"), "called.json");
    expect(startCapture(path.join(wt), fakeBin(marker))).toBe(true);
    expect(JSON.parse(await waitFor(marker))).toEqual({ argv: ["capture", "--repo", repo], env: "1" });
  });

  it("logs and does nothing when the repobrain bin is missing", () => {
    const key = connectRepo(repo);
    const bin = path.join(tempDir("repobrain-bin-"), "bin.js");
    expect(startCapture(repo, bin)).toBe(false);
    expect(fs.readFileSync(path.join(repoDir(key), "capture.log"), "utf8")).toContain(`repobrain bin missing at ${bin}; rebuild or reinstall`);
  });

  it("sends the detached capture's stderr to capture-errors.log", async () => {
    connectRepo(repo);
    const bin = path.join(tempDir("repobrain-bin-"), "bin.mjs");
    fs.writeFileSync(bin, `import "./no-such-module.js";`);
    expect(startCapture(repo, bin)).toBe(true);
    const log = path.join(home, "capture-errors.log");
    await waitUntil(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("no-such-module"));
  });

  it("still starts capture when capture-errors.log can't be opened", async () => {
    connectRepo(repo);
    fs.mkdirSync(path.join(home, "capture-errors.log"));
    const marker = path.join(tempDir("m-"), "called.json");
    expect(startCapture(repo, fakeBin(marker))).toBe(true);
    expect(JSON.parse(await waitFor(marker)).argv[0]).toBe("capture");
  });

  it("never throws, even when it can't read the config", () => {
    connectRepo(repo);
    fs.writeFileSync(path.join(home, "config.json"), "{not json");
    expect(startCapture(repo, fakeBin(path.join(tempDir("m-"), "x")))).toBe(false);
  });
});

describe("the built hook", () => {
  let hookBin: string;
  let repo: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  /** A copy of the build whose bin.js only records how it was called, to the file in REPOBRAIN_TEST_MARKER. */
  let recordingHookBin: string;
  beforeAll(() => {
    // Build to a temp dir, with this repo's node_modules linked in so ts-fsrs resolves.
    const out = tempDir("repobrain-hook-");
    const root = path.resolve(import.meta.dirname, "..");
    execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(root, "tsconfig.build.json"), "--outDir", out]);
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n');
    fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"));
    hookBin = path.join(out, "hook-bin.js");
    const recording = tempDir("repobrain-hook-rec-");
    fs.cpSync(out, recording, { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(
      path.join(recording, "bin.js"),
      'import fs from "node:fs"; fs.writeFileSync(process.env.REPOBRAIN_TEST_MARKER, JSON.stringify({ argv: process.argv.slice(2), env: process.env.REPOBRAIN_CAPTURE }));',
    );
    recordingHookBin = path.join(recording, "hook-bin.js");
  }, 60_000);
  beforeEach(() => {
    home = useTempHome();
    repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    env = { ...process.env, REPOBRAIN_HOME: home };
    delete env.REPOBRAIN_CAPTURE;
  });

  it("does nothing, and writes nothing, for an unconnected repo", () => {
    const r = runHook(hookBin, JSON.stringify({ cwd: repo, hook_event_name: "SessionStart" }), env);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("starts the real capture in the background for a connected repo", async () => {
    const key = connectRepo(repo);
    const r = runHook(hookBin, JSON.stringify({ cwd: repo, hook_event_name: "SessionStart" }), env);
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    // A first capture only initialises (no claude call), saving the head commit.
    const state = JSON.parse(await waitFor(path.join(repoDir(key), "state.json"))) as { lastSha: string };
    expect(state.lastSha).toBe(sh(repo, ["rev-parse", "HEAD"]));
    // Let the capture finish before the temp home goes away.
    await waitUntil(() => !fs.existsSync(path.join(repoDir(key), "capture.lock")));
  });

  it("spawns capture for the main repo when the session is in a worktree outside it", async () => {
    connectRepo(repo);
    const wt = path.join(tempDir("repobrain-wt-"), "feat");
    sh(repo, ["worktree", "add", "-q", "-b", "feat", wt]);
    const marker = path.join(tempDir("m-"), "called.json");
    const r = runHook(recordingHookBin, JSON.stringify({ cwd: path.join(wt) }), { ...env, REPOBRAIN_TEST_MARKER: marker });
    expect(r).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(JSON.parse(await waitFor(marker))).toEqual({ argv: ["capture", "--repo", repo], env: "1" });
  });

  it("still exits 0 quickly when git hangs", () => {
    connectRepo(repo);
    const stub = tempDir("repobrain-stub-");
    fs.writeFileSync(path.join(stub, "git"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 });
    const r = runHook(hookBin, JSON.stringify({ cwd: repo }), { ...env, PATH: `${stub}${path.delimiter}${env.PATH}` });
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(3500);
  });

  it("never runs git for a directory outside every connected repo", () => {
    const stub = tempDir("repobrain-stub-");
    const marker = path.join(stub, "git-ran");
    fs.writeFileSync(path.join(stub, "git"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    const pathEnv = `${stub}${path.delimiter}${env.PATH}`;
    // No repos connected at all.
    expect(runHook(hookBin, JSON.stringify({ cwd: repo }), { ...env, PATH: pathEnv }).status).toBe(0);
    // A repo connected, but the session is elsewhere.
    connectRepo(repo);
    expect(runHook(hookBin, JSON.stringify({ cwd: tempDir("repobrain-plain-") }), { ...env, PATH: pathEnv }).status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does nothing inside a capture's own claude session", async () => {
    const key = connectRepo(repo);
    const r = runHook(hookBin, JSON.stringify({ cwd: repo }), { ...env, REPOBRAIN_CAPTURE: "1" });
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 500));
    expect(fs.existsSync(path.join(repoDir(key), "state.json"))).toBe(false);
  });

  it("fails open on malformed stdin", () => {
    expect(runHook(hookBin, "{not json", env)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(runHook(hookBin, "null", env)).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(runHook(hookBin, '{"cwd": 42}', env)).toMatchObject({ status: 0, stdout: "", stderr: "" });
  });

  it("exits 0 promptly when stdin is never closed", () => {
    // The parent keeps the hook's stdin pipe open, so only the hook's own timeout ends it.
    const parent = `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify("HOOK")}], { stdio: ["pipe", "inherit", "inherit"] });
      c.on("exit", (code) => process.exit(code ?? 99));`;
    const started = Date.now();
    const r = spawnSync(process.execPath, ["-e", parent.replace(JSON.stringify("HOOK"), JSON.stringify(hookBin))], {
      env, cwd: tempDir("repobrain-cwd-"), encoding: "utf8", timeout: 15_000,
    });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(6000);
  });
});
