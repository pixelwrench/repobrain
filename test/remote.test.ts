import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { InMemoryTransport, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { authPath, FileOAuthProvider } from "../src/auth.js";
import { CLIENT_INFO, connectRemote, RemoteError, toRemoteError, type Remote } from "../src/remote.js";
import { startFakeSite, type FakeSite } from "./fake-site.js";
import { VERSION } from "../src/version.js";
import { buildSync } from "esbuild";
import { tempDir, useTempHome } from "./helpers.js";

function testServer(): McpServer {
  const server = new McpServer({ name: "test-site", version: "1.0.0" });
  server.registerTool("echo_json", { inputSchema: z.object({ n: z.number() }) }, async ({ n }) => ({
    content: [{ type: "text", text: JSON.stringify({ doubled: n * 2 }) }],
  }));
  server.registerTool("fails", { inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "Deck not found" }],
    isError: true,
  }));
  server.registerTool("not_json", { inputSchema: z.object({}) }, async () => ({
    content: [{ type: "text", text: "plain words" }],
  }));
  return server;
}

const open: Remote[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function inMemoryRemote(): Promise<Remote> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await testServer().connect(serverTransport);
  const remote = await connectRemote("http://site.invalid", { transport: clientTransport });
  open.push(remote);
  return remote;
}

async function caught(p: Promise<unknown>): Promise<RemoteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RemoteError);
    return e as RemoteError;
  }
  throw new Error("expected a RemoteError");
}

describe("connectRemote", () => {
  it("parses a tool's JSON text result", async () => {
    const remote = await inMemoryRemote();
    expect(await remote.call<{ doubled: number }>("echo_json", { n: 21 })).toEqual({ doubled: 42 });
  });

  it("throws a tool error carrying the text when the result has isError", async () => {
    const remote = await inMemoryRemote();
    const e = await caught(remote.call("fails", {}));
    expect(e.kind).toBe("tool");
    expect(e.message).toBe("Deck not found");
  });

  it("throws a tool error when the result is not JSON", async () => {
    const remote = await inMemoryRemote();
    expect((await caught(remote.call("not_json", {}))).kind).toBe("tool");
  });

  it("throws a tool error for an unknown tool", async () => {
    const remote = await inMemoryRemote();
    expect((await caught(remote.call("no_such_tool", {}))).kind).toBe("tool");
  });

  it("maps a 401 from the site to an auth error", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"invalid_token"}');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect((await caught(connectRemote(`http://127.0.0.1:${port}`))).kind).toBe("auth");
  });

  it("maps an unreachable site to a network error", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    expect((await caught(connectRemote(`http://127.0.0.1:${port}`))).kind).toBe("network");
  });
});

describe("toRemoteError", () => {
  it("classifies auth failures", () => {
    expect(toRemoteError(new UnauthorizedError()).kind).toBe("auth");
    expect(toRemoteError(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "401", { status: 401 })).kind).toBe("auth");
  });

  it("classifies connection failures and server errors as network", () => {
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    expect(toRemoteError(refused).kind).toBe("network");
    expect(toRemoteError(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "502", { status: 502 })).kind).toBe("network");
    expect(toRemoteError(Object.assign(new Error("aborted"), { name: "AbortError" })).kind).toBe("network");
  });

  it("doesn't call other failures network ones", () => {
    expect(toRemoteError(new Error("Either provider.prepareTokenRequest() or authorizationCode is required")).kind).toBe("tool");
    expect(toRemoteError(new Error("odd"), "auth").kind).toBe("auth");
    expect(toRemoteError(new TypeError("x is not a function")).kind).toBe("tool");
    expect(toRemoteError(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "404", { status: 404 })).kind).toBe("tool");
  });

  it("keeps a RemoteError as it is", () => {
    const e = new RemoteError("x", "tool");
    expect(toRemoteError(e)).toBe(e);
  });
});

describe("connectRemote with stored tokens", () => {
  // Token-looking values are built by concatenation so secret scanners don't flag the repo.
  const EXPIRED = "old-" + "access";
  const FRESH = "new-" + "access";
  const REFRESH = "rt-" + "one";
  const ROTATED = "rt-" + "two";
  let site: FakeSite;
  beforeEach(() => {
    useTempHome();
  });
  afterEach(async () => {
    await site?.close();
  });

  /** Stored as the SDK leaves them: stamped with the issuer they came from. */
  async function signedIn(base: string): Promise<void> {
    const p = new FileOAuthProvider(base);
    p.saveClientInformation({ client_id: "c1", redirect_uris: ["http://127.0.0.1:1/callback"], issuer: base });
    p.saveTokens({ access_token: EXPIRED, token_type: "bearer", refresh_token: REFRESH, issuer: base });
  }

  it("refreshes an expired access token without a browser and saves the rotated tokens", async () => {
    site = await startFakeSite({
      accept: [FRESH],
      token: (form) =>
        form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH
          ? { status: 200, body: { access_token: FRESH, token_type: "bearer", refresh_token: ROTATED } }
          : { status: 400, body: { error: "invalid_grant" } },
    });
    await signedIn(site.base);
    const remote = await connectRemote(site.base);
    open.push(remote);
    expect(await remote.call("list_my_decks", {})).toEqual({ ok: true });
    expect(site.hits).toContain("POST /token refresh_token");
    const stored = JSON.parse(fs.readFileSync(authPath(), "utf8")).sites[site.base].tokens;
    // The SDK's issuer stamp is kept, so it checks the tokens belong to this site's authorization server.
    expect(stored).toMatchObject({ access_token: FRESH, refresh_token: ROTATED, issuer: site.base });
  });

  /** Bundles the client so plain node child processes can run it; each run connects and calls one tool. */
  async function callerProcess(base: string, refreshTimeoutMs?: number) {
    const out = tempDir("repobrain-remote-bundle-");
    buildSync({
      entryPoints: [path.resolve(import.meta.dirname, "../src/remote.ts")],
      bundle: true, platform: "node", format: "esm", target: "node24", outfile: path.join(out, "remote.mjs"), logLevel: "warning",
    });
    const caller = path.join(out, "caller.mjs");
    fs.writeFileSync(caller, [
      'import { connectRemote } from "./remote.mjs";',
      "try {",
      `  const remote = await connectRemote(process.argv[2], { refreshTimeoutMs: ${refreshTimeoutMs ?? "undefined"} });`,
      '  await remote.call("list_my_decks", {});',
      "  await remote.close();",
      "} catch (e) {",
      '  process.stderr.write(`${e.kind}: ${e.message}\\n`);',
      "  process.exit(1);",
      "}",
      "",
    ].join("\n"));
    return () =>
      new Promise<{ code: number | null; stderr: string; ms: number }>((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [caller, base], { stdio: ["ignore", "inherit", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("exit", (code) => resolve({ code, stderr, ms: Date.now() - started }));
      });
  }

  it("reports a sign-in lock held too long as busy (network), not as an expired sign-in", async () => {
    site = await startFakeSite({ accept: [FRESH], token: () => ({ status: 200, body: { access_token: FRESH, token_type: "bearer" } }) });
    await signedIn(site.base);
    fs.writeFileSync(`${authPath()}.lock`, `${process.pid}:someone-else`);
    const e = await caught(connectRemote(site.base, { lockWaitMs: 200 }));
    expect(e.kind).toBe("network");
    expect(e.message).toMatch(/busy/);
    expect(site.hits).not.toContain("POST /token refresh_token");
    fs.rmSync(`${authPath()}.lock`);
  });

  it("gives up on a token endpoint that never answers, so the lock is never held for long", async () => {
    site = await startFakeSite({ accept: [FRESH], token: () => new Promise(() => {}) });
    await signedIn(site.base);
    const run = await callerProcess(site.base, 500);
    const first = run();
    // The second starts once the first holds the lock and waits on the site.
    while (!site.hits.includes("POST /token refresh_token")) await new Promise((r) => setTimeout(r, 20));
    const [a, b] = await Promise.all([first, run()]);
    for (const r of [a, b]) {
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^network: /m);
    }
    expect(b.ms).toBeLessThan(8_000);
    // A timeout is no reason to forget the sign-in.
    expect(JSON.parse(fs.readFileSync(authPath(), "utf8")).sites[site.base].tokens.refresh_token).toBe(REFRESH);
  }, 60_000);

  it("lets processes refreshing at once share one rotation, so none is signed out", async () => {
    // The site rotates refresh tokens and refuses a used one, as a real authorization server may.
    // Each refresh is slow, so without a lock every process would send the same refresh token.
    let live = REFRESH;
    let issued = 0;
    const accept: string[] = [];
    site = await startFakeSite({
      accept,
      token: async (form) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== live) return { status: 400, body: { error: "invalid_grant" } };
        issued++;
        live = "rt-" + `rotated-${issued}`;
        const access = "at-" + `fresh-${issued}`;
        accept.push(access);
        return { status: 200, body: { access_token: access, token_type: "bearer", refresh_token: live } };
      },
    });
    await signedIn(site.base);
    const run = await callerProcess(site.base);
    expect((await Promise.all([run(), run(), run()])).map((r) => r.code)).toEqual([0, 0, 0]);
    expect(issued).toBe(1);
    const stored = JSON.parse(fs.readFileSync(authPath(), "utf8")).sites[site.base].tokens;
    expect(stored.refresh_token).toBe(live);
    expect(accept).toContain(stored.access_token);
    expect(fs.readdirSync(process.env.REPOBRAIN_HOME!).filter((f) => f !== "auth.json")).toEqual([]);
  }, 60_000);

  it("reports a refused refresh token as an auth error that names repobrain login", async () => {
    site = await startFakeSite({ accept: [FRESH], token: () => ({ status: 400, body: { error: "invalid_grant" } }) });
    await signedIn(site.base);
    const e = await caught(connectRemote(site.base));
    expect(e.kind).toBe("auth");
    expect(e.message).toMatch(/repobrain login/);
  });

  it("reports a missing sign-in as an auth error", async () => {
    site = await startFakeSite({ accept: [FRESH], token: () => ({ status: 400, body: {} }) });
    const e = await caught(connectRemote(site.base));
    expect(e.kind).toBe("auth");
    expect(e.message).toMatch(/repobrain login/);
  });
});

describe("CLIENT_INFO", () => {
  it("carries the version, which matches package.json's and the plugin's", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")) as { version: string };
    expect(CLIENT_INFO).toEqual({ name: "repobrain", version: VERSION });
    expect(VERSION).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
  });
});
