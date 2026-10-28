import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startCapture } from "../src/hook.js";
import { connectRepo, repoDir } from "../src/store.js";
import { commit, makeRepo, sh, tempDir, useTempHome } from "./helpers.js";

/** A stand-in for bin.js that records how it was called. */
function fakeBin(marker: string): string {
  const file = path.join(tempDir("codebrain-bin-"), "bin.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.CODEBRAIN_CAPTURE }));`,
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
    delete process.env.CODEBRAIN_CAPTURE;
    home = useTempHome();
    repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
  });
  afterEach(() => {
    delete process.env.CODEBRAIN_CAPTURE;
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
    process.env.CODEBRAIN_CAPTURE = "1";
    expect(startCapture(repo, fakeBin(path.join(tempDir("m-"), "x")))).toBe(false);
  });

  it("starts a detached capture with the recursion guard set", async () => {
    connectRepo(repo);
    const marker = path.join(tempDir("m-"), "called.json");
    expect(startCapture(repo, fakeBin(marker))).toBe(true);
    expect(JSON.parse(await waitFor(marker))).toEqual({ argv: ["capture", "--repo", repo], env: "1" });
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
  beforeAll(() => {
    // Build to a temp dir, with this repo's node_modules linked in so ts-fsrs resolves.
    const out = tempDir("codebrain-hook-");
    const root = path.resolve(import.meta.dirname, "..");
    execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", path.join(root, "tsconfig.build.json"), "--outDir", out]);
    fs.writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n');
    fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"));
    hookBin = path.join(out, "hook-bin.js");
  });
  beforeEach(() => {
    home = useTempHome();
    repo = makeRepo();
    commit(repo, { "a.txt": "a\n" }, "first");
    env = { ...process.env, CODEBRAIN_HOME: home };
    delete env.CODEBRAIN_CAPTURE;
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
  });

  it("does nothing inside a capture's own claude session", async () => {
    const key = connectRepo(repo);
    const r = runHook(hookBin, JSON.stringify({ cwd: repo }), { ...env, CODEBRAIN_CAPTURE: "1" });
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
    const r = spawnSync(process.execPath, ["-e", parent.replace(JSON.stringify("HOOK"), JSON.stringify(hookBin))], { env, encoding: "utf8", timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
