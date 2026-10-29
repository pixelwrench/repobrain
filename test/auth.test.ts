import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authPath, FileOAuthProvider, login, logout, resolveSite, DEFAULT_SITE, type AuthFlow, type LoginDeps } from "../src/auth.js";
import { main } from "../src/cli.js";
import type { Remote } from "../src/remote.js";
import { useTempHome } from "./helpers.js";

// Token-looking values are built by concatenation so secret scanners don't flag the repo.
const ACCESS = "at-" + "fake-access-value";
const REFRESH = "rt-" + "fake-refresh-value";
const tokens = (access = ACCESS) => ({ access_token: access, token_type: "bearer", refresh_token: REFRESH });
const SITE_A = "http://localhost:3000";
const SITE_B = "https://repobrain.example";

const readAuth = () => JSON.parse(fs.readFileSync(authPath(), "utf8"));

beforeEach(() => {
  useTempHome();
});

describe("FileOAuthProvider storage", () => {
  it("writes auth.json with mode 0600", async () => {
    await new FileOAuthProvider(SITE_A).saveTokens(tokens());
    expect(fs.statSync(authPath()).mode & 0o777).toBe(0o600);
    expect(path.dirname(authPath())).toBe(process.env.REPOBRAIN_HOME);
  });

  it("keeps each site's client and tokens separately", async () => {
    const a = new FileOAuthProvider(SITE_A);
    const b = new FileOAuthProvider(SITE_B);
    await a.saveClientInformation({ client_id: "client-a" });
    await a.saveTokens(tokens("a-" + "token"));
    await b.saveTokens(tokens("b-" + "token"));
    expect((await new FileOAuthProvider(SITE_A).tokens())?.access_token).toBe("a-" + "token");
    expect((await new FileOAuthProvider(SITE_B).tokens())?.access_token).toBe("b-" + "token");
    expect((await new FileOAuthProvider(SITE_A).clientInformation())?.client_id).toBe("client-a");
    expect(Object.keys(readAuth().sites).sort()).toEqual([SITE_B, SITE_A].sort());
  });

  it("invalidates tokens without dropping the client", async () => {
    const a = new FileOAuthProvider(SITE_A);
    await a.saveClientInformation({ client_id: "client-a" });
    await a.saveTokens(tokens());
    await a.invalidateCredentials("tokens");
    expect(await a.tokens()).toBeUndefined();
    expect((await a.clientInformation())?.client_id).toBe("client-a");
  });

  it("describes a public native client for the loopback redirect", () => {
    const p = new FileOAuthProvider(SITE_A, { redirectUrl: "http://127.0.0.1:4567/callback", onRedirect: () => {} });
    expect(p.clientMetadata).toMatchObject({
      client_name: "RepoBrain plugin",
      redirect_uris: ["http://127.0.0.1:4567/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  it("re-registers when the stored client was registered for another loopback port", async () => {
    await new FileOAuthProvider(SITE_A).saveClientInformation({ client_id: "old", redirect_uris: ["http://127.0.0.1:1111/callback"] });
    const p = new FileOAuthProvider(SITE_A, { redirectUrl: "http://127.0.0.1:2222/callback", onRedirect: () => {} });
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("refuses to start a browser sign-in when not run from login", async () => {
    const p = new FileOAuthProvider(SITE_A);
    await expect(Promise.resolve().then(() => p.clientInformation())).rejects.toThrow(/repobrain login/);
    await expect(Promise.resolve().then(() => p.redirectToAuthorization(new URL("https://as.example/authorize")))).rejects.toThrow(/repobrain login/);
  });

  it("keeps the code verifier in memory only", async () => {
    const p = new FileOAuthProvider(SITE_A);
    await p.saveCodeVerifier("verifier-value");
    await p.saveTokens(tokens());
    expect(await p.codeVerifier()).toBe("verifier-value");
    expect(fs.readFileSync(authPath(), "utf8")).not.toContain("verifier-value");
  });
});

describe("resolveSite", () => {
  const saved = process.env.REPOBRAIN_SITE;
  afterEach(() => {
    if (saved === undefined) delete process.env.REPOBRAIN_SITE;
    else process.env.REPOBRAIN_SITE = saved;
  });

  it("takes --site, else REPOBRAIN_SITE, else the default", () => {
    delete process.env.REPOBRAIN_SITE;
    expect(resolveSite(undefined)).toBe(DEFAULT_SITE);
    process.env.REPOBRAIN_SITE = "https://env.example/";
    expect(resolveSite(undefined)).toBe("https://env.example");
    expect(resolveSite("http://localhost:3000/")).toBe("http://localhost:3000");
  });

  it("refuses plain http except on this machine", () => {
    expect(() => resolveSite("http://repobrain.example")).toThrow(/https/);
    expect(() => resolveSite("ftp://x.example")).toThrow();
    expect(() => resolveSite("not a url")).toThrow();
    expect(resolveSite("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });
});

/** A stand-in for the SDK's auth(): the first call sends the user to the AS, the second redeems the code. */
function fakeFlow(seen: { codes: string[] }): AuthFlow {
  return async (provider, options) => {
    expect(String(options.serverUrl)).toBe(`${SITE_A}/api/mcp`);
    if (options.authorizationCode === undefined) {
      await provider.saveCodeVerifier("v");
      const url = new URL("https://as.example/authorize");
      url.searchParams.set("state", await provider.state!());
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      return "REDIRECT";
    }
    seen.codes.push(options.authorizationCode);
    await provider.saveTokens(tokens());
    return "AUTHORIZED";
  };
}

/** A stand-in browser: follows the authorization URL straight back to the loopback callback. */
const browserReturning = (code: string, state?: string) => async (url: URL) => {
  const back = new URL(url.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", code);
  back.searchParams.set("state", state ?? url.searchParams.get("state")!);
  await fetch(back);
};

function fakeConnect(calls: string[]): NonNullable<LoginDeps["connect"]> {
  return async (_site, provider) => {
    const remote: Remote = {
      async call<T>(tool: string): Promise<T> {
        calls.push(`${tool}:${(await provider.tokens())?.access_token === ACCESS}`);
        return [] as T;
      },
      close: async () => {},
    };
    return remote;
  };
}

describe("login", () => {
  it("signs in through the loopback callback and proves the token with a read tool", async () => {
    const seen = { codes: [] as string[] };
    const calls: string[] = [];
    const notices: string[] = [];
    const out = await login(SITE_A, {
      authFlow: fakeFlow(seen),
      openBrowser: browserReturning("the-code"),
      connect: fakeConnect(calls),
      notify: (m) => notices.push(m),
    });
    expect(out).toEqual({ site: SITE_A, signedIn: true });
    expect(seen.codes).toEqual(["the-code"]);
    expect(calls).toEqual(["list_my_decks:true"]);
    expect(notices.join("\n")).toContain("https://as.example/authorize");
    expect(readAuth().sites[SITE_A].tokens.refresh_token).toBe(REFRESH);
    expect(notices.join("\n")).not.toContain(ACCESS);
  });

  it("rejects a callback whose state doesn't match", async () => {
    const seen = { codes: [] as string[] };
    await expect(
      login(SITE_A, { authFlow: fakeFlow(seen), openBrowser: browserReturning("c", "forged"), connect: fakeConnect([]), notify: () => {} }),
    ).rejects.toThrow(/state/);
    expect(seen.codes).toEqual([]);
  });

  it("gives up when no callback arrives in time", async () => {
    await expect(
      login(SITE_A, { authFlow: fakeFlow({ codes: [] }), openBrowser: async () => {}, connect: fakeConnect([]), notify: () => {}, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });

  it("still works when the browser can't be opened", async () => {
    const calls: string[] = [];
    let opened: URL | null = null;
    const out = await login(SITE_A, {
      authFlow: fakeFlow({ codes: [] }),
      openBrowser: async (url) => {
        opened = url;
        // The user opens the printed URL themselves; the opener itself fails.
        setTimeout(() => void browserReturning("c")(url), 10);
        throw new Error("no browser");
      },
      connect: fakeConnect(calls),
      notify: () => {},
    });
    expect(opened).not.toBeNull();
    expect(out.signedIn).toBe(true);
  });
});

describe("logout", () => {
  it("removes one site only", async () => {
    await new FileOAuthProvider(SITE_A).saveTokens(tokens());
    await new FileOAuthProvider(SITE_B).saveTokens(tokens());
    expect(logout(SITE_A)).toEqual({ site: SITE_A, signedIn: false });
    expect(Object.keys(readAuth().sites)).toEqual([SITE_B]);
    expect(fs.statSync(authPath()).mode & 0o777).toBe(0o600);
  });
});

describe("cli login and logout", () => {
  it("logs in to --site and never prints the token", async () => {
    const res = await main(["login", "--site", SITE_A], {
      login: { authFlow: fakeFlow({ codes: [] }), openBrowser: browserReturning("c"), connect: fakeConnect([]), notify: () => {} },
    });
    expect(res).toEqual({ code: 0, out: { site: SITE_A, signedIn: true } });
    expect(JSON.stringify(res)).not.toContain(ACCESS);
  });

  it("logs out of --site", async () => {
    await new FileOAuthProvider(SITE_A).saveTokens(tokens());
    expect(await main(["logout", "--site", SITE_A])).toEqual({ code: 0, out: { site: SITE_A, signedIn: false } });
    expect(readAuth().sites).toEqual({});
  });

  it("reports a bad --site as a usage error", async () => {
    expect((await main(["logout", "--site", "http://repobrain.example"])).code).toBe(2);
  });
});

describe("login with the SDK's own auth()", () => {
  // A stand-in for the site's protected-resource metadata and its OAuth 2.1 server (dynamic registration, PKCE).
  let as: http.Server;
  let base: string;
  const registered: Record<string, unknown>[] = [];
  let challenge = "";
  beforeEach(async () => {
    registered.length = 0;
    as = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", base);
      let body = "";
      for await (const chunk of req) body += chunk;
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
        return json(200, { resource: `${base}/api/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const meta = JSON.parse(body) as Record<string, unknown>;
        registered.push(meta);
        return json(201, { ...meta, client_id: `client-${registered.length}` });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body);
        const verifier = form.get("code_verifier") ?? "";
        const ok = form.get("code") === "real-code" && createHash("sha256").update(verifier).digest("base64url") === challenge;
        return ok ? json(200, tokens()) : json(400, { error: "invalid_grant" });
      }
      return json(404, {});
    });
    await new Promise<void>((resolve) => as.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(as.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    as.closeAllConnections();
    await new Promise((resolve) => as.close(resolve));
  });

  const browser = async (url: URL) => {
    expect(url.origin + url.pathname).toBe(`${base}/authorize`);
    challenge = url.searchParams.get("code_challenge")!;
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", "real-code");
    back.searchParams.set("state", url.searchParams.get("state")!);
    await fetch(back);
  };

  it("registers a public client, redeems the code with PKCE, and stores the tokens", async () => {
    const calls: string[] = [];
    const out = await login(base, { openBrowser: browser, connect: fakeConnect(calls), notify: () => {} });
    expect(out).toEqual({ site: base, signedIn: true });
    expect(calls).toEqual(["list_my_decks:true"]);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ client_name: "RepoBrain plugin", token_endpoint_auth_method: "none" });
    const stored = readAuth().sites[base];
    expect(stored.tokens.refresh_token).toBe(REFRESH);
    expect(stored.clientInformation.client_id).toBe("client-1");
    expect(JSON.stringify(stored)).not.toContain(challenge);
  });

  it("registers again on the next login, whose loopback port differs", async () => {
    await login(base, { openBrowser: browser, connect: fakeConnect([]), notify: () => {} });
    await logout(base);
    await new FileOAuthProvider(base).saveClientInformation({ client_id: "stale", redirect_uris: ["http://127.0.0.1:1/callback"] });
    await login(base, { openBrowser: browser, connect: fakeConnect([]), notify: () => {} });
    expect(registered).toHaveLength(2);
    expect(readAuth().sites[base].clientInformation.client_id).toBe("client-2");
  });
});

describe("login failures", () => {
  it("names an unreachable site as a network error", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await new Promise((resolve) => server.close(resolve));
    await expect(login(site, { openBrowser: async () => {}, connect: fakeConnect([]), notify: () => {} })).rejects.toMatchObject({
      kind: "network",
      message: expect.stringMatching(/could not reach the site/),
    });
  });
});
