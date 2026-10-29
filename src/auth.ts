import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  auth, UnauthorizedError,
  type AuthResult, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { connectRemote, mcpUrl, toRemoteError, type Remote } from "./remote.js";
import { acquireFileLock, home, readJson, writeFileAtomic } from "./store.js";

export const DEFAULT_SITE = "https://repobrain.com";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The site from `--site`, else `REPOBRAIN_SITE`, else the default, as an origin plus path with no trailing
 * slash. Plain http is allowed only on this machine, since tokens travel to it.
 */
export function resolveSite(flag: string | undefined): string {
  const raw = flag ?? process.env.REPOBRAIN_SITE ?? DEFAULT_SITE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid site URL ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`the site must use https (plain http only for localhost): ${JSON.stringify(raw)}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// ---- auth.json: each site's registered client and tokens. ----

interface SiteAuth {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}
interface AuthFile {
  sites: Record<string, SiteAuth>;
}

export const authPath = (): string => path.join(home(), "auth.json");

function readAuthFile(): AuthFile {
  const data = readJson<Partial<AuthFile> | null>(authPath(), null);
  const sites = data?.sites;
  return { sites: sites && typeof sites === "object" && !Array.isArray(sites) ? sites : {} };
}

/** Holds refresh tokens, so it is readable by the user only, in a home folder created private. */
function writeAuthFile(data: AuthFile): void {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileAtomic(authPath(), JSON.stringify(data, null, 2) + "\n", 0o600);
}

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Runs a read-modify-write of auth.json under an exclusive lock, so background captures refreshing tokens at
 * the same time can't drop each other's rotated tokens.
 */
function withAuthLock<T>(fn: () => T): T {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock = acquireFileLock(`${authPath()}.lock`, LOCK_STALE_MS);
  while (!lock) {
    if (Date.now() > deadline) throw new Error(`${authPath()} is locked by another repobrain process; try again`);
    Atomics.wait(pause, 0, 0, 10 + Math.random() * 20);
    lock = acquireFileLock(`${authPath()}.lock`, LOCK_STALE_MS);
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function updateSite(site: string, change: (entry: SiteAuth) => SiteAuth | undefined): void {
  withAuthLock(() => {
    const data = readAuthFile(); // read inside the lock, so another process's write is never lost
    const next = change({ ...data.sites[site] });
    if (next === undefined) delete data.sites[site];
    else data.sites[site] = next;
    writeAuthFile(data);
  });
}

const notSignedIn = (site: string): UnauthorizedError =>
  new UnauthorizedError(`not signed in to ${site}: run repobrain login --site ${site}`);

export interface FileOAuthProviderOptions {
  /** The loopback callback. Only `login` sets it; without it the provider never starts a browser sign-in. */
  redirectUrl: string;
  /** Called with the authorization URL to send the user to. */
  onRedirect: (url: URL) => void | Promise<void>;
}

/**
 * The SDK's OAuth client provider, keeping each site's client and tokens in `auth.json`. The PKCE verifier,
 * state and discovery results stay in memory, since they only matter during one sign-in.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  private stateValue?: string;

  constructor(readonly site: string, private readonly interactive?: FileOAuthProviderOptions) {}

  /**
   * The loopback callback during login. Outside login it is the stored client's registered callback: the SDK
   * takes a provider with no redirect URL for a client-credentials client and never refreshes its tokens.
   */
  get redirectUrl(): string | undefined {
    if (this.interactive) return this.interactive.redirectUrl;
    const uris = (readAuthFile().sites[this.site]?.clientInformation as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    return Array.isArray(uris) && typeof uris[0] === "string" ? uris[0] : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "RepoBrain plugin",
      redirect_uris: this.interactive ? [this.interactive.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** A fresh random state per sign-in, checked against the callback. */
  state(): string {
    this.stateValue ??= randomBytes(16).toString("base64url");
    return this.stateValue;
  }
  get expectedState(): string | undefined {
    return this.stateValue;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const info = readAuthFile().sites[this.site]?.clientInformation;
    if (!this.interactive) {
      // Registering a client is part of signing in; outside login there's nothing to do but ask for it.
      if (!info) throw notSignedIn(this.site);
      return info;
    }
    // The loopback port changes with each login, so a client registered for another port can't be used.
    const uris = (info as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    if (Array.isArray(uris) && !uris.includes(this.interactive.redirectUrl)) return undefined;
    return info;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    updateSite(this.site, (e) => ({ ...e, clientInformation: info }));
  }

  tokens(): StoredOAuthTokens | undefined {
    return readAuthFile().sites[this.site]?.tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    updateSite(this.site, (e) => ({ ...e, tokens }));
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw notSignedIn(this.site);
    await this.interactive.onRedirect(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("no sign-in in progress");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client" || scope === "tokens") {
      updateSite(this.site, (e) => {
        if (scope === "all" || scope === "client") delete e.clientInformation;
        if (scope === "all" || scope === "tokens") delete e.tokens;
        return e.clientInformation || e.tokens ? e : undefined;
      });
    }
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
  }
}

// ---- The loopback callback. ----

interface CallbackListener {
  redirectUrl: string;
  /** Resolves with the callback's query once the browser returns to it. */
  wait(timeoutMs: number): Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (heading: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>RepoBrain</title><h1>${heading}</h1><p>${text}</p>`;

/** Listens on 127.0.0.1 at a free port, before the flow starts, so the redirect URL is known. */
async function listenForCallback(): Promise<CallbackListener> {
  let deliver: (params: URLSearchParams) => void = () => {};
  const received = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const failed = url.searchParams.has("error") || !url.searchParams.has("code");
    res.writeHead(failed ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(failed ? PAGE("Sign-in failed", "Return to the terminal for details.") : PAGE("Signed in", "You can close this tab and return to the terminal."));
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    wait(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sign-in timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      });
      return Promise.race([received, timeout]).finally(() => clearTimeout(timer));
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Opens the URL with the system's opener, ignoring failures: the URL is printed too. */
export async function openInBrowser(url: URL): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(command, [url.toString()], { stdio: "ignore", detached: true });
      child.once("error", () => resolve());
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

// ---- login and logout. ----

/** The SDK's `auth()`, injectable so tests can stand in for the authorization server. */
export type AuthFlow = (
  provider: OAuthClientProvider,
  options: { serverUrl: string | URL; authorizationCode?: string; iss?: string },
) => Promise<AuthResult>;

export interface LoginDeps {
  authFlow?: AuthFlow;
  openBrowser?: (url: URL) => Promise<void>;
  connect?: (site: string, provider: OAuthClientProvider) => Promise<Remote>;
  /** Where the sign-in URL is shown. stdout carries the command's JSON, so this defaults to stderr. */
  notify?: (message: string) => void;
  timeoutMs?: number;
}

export interface LoginOutput {
  site: string;
  signedIn: boolean;
}

/** Signs in to the site in the browser (OAuth with PKCE and a loopback redirect), and stores the tokens. */
export async function login(site: string, deps: LoginDeps = {}): Promise<LoginOutput> {
  const flow = deps.authFlow ?? auth;
  // Discovery, registration and the token exchange fail as auth or network errors with a readable message.
  const authFlow: AuthFlow = (provider, options) => flow(provider, options).catch((e: unknown) => {
    throw toRemoteError(e, "auth");
  });
  const openBrowser = deps.openBrowser ?? openInBrowser;
  const notify = deps.notify ?? ((m: string) => process.stderr.write(m + "\n"));
  const connect = deps.connect ?? ((s: string, authProvider: OAuthClientProvider) => connectRemote(s, { authProvider }));
  const serverUrl = mcpUrl(site);

  const listener = await listenForCallback();
  try {
    const provider = new FileOAuthProvider(site, {
      redirectUrl: listener.redirectUrl,
      onRedirect: async (url) => {
        notify(`Sign in to RepoBrain in your browser. If it doesn't open, visit:\n${url.toString()}`);
        await openBrowser(url).catch(() => {});
      },
    });
    let result = await authFlow(provider, { serverUrl });
    if (result === "REDIRECT") {
      const params = await listener.wait(deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
      const error = params.get("error");
      if (error) throw new Error(`sign-in failed: ${error}${params.has("error_description") ? ` (${params.get("error_description")})` : ""}`);
      if (!provider.expectedState || params.get("state") !== provider.expectedState) {
        throw new Error("sign-in failed: the callback's state doesn't match this sign-in");
      }
      const code = params.get("code");
      if (!code) throw new Error("sign-in failed: the callback carried no code");
      result = await authFlow(provider, { serverUrl, authorizationCode: code, iss: params.get("iss") ?? undefined });
    }
    if (result !== "AUTHORIZED") throw new Error("sign-in failed: the site did not issue a token");

    const remote = await connect(site, provider);
    try {
      await remote.call("list_my_decks", {});
    } finally {
      await remote.close();
    }
    return { site, signedIn: true };
  } finally {
    listener.close();
  }
}

/** Forgets the site's client and tokens; other sites are kept. */
export function logout(site: string): LoginOutput {
  updateSite(site, () => undefined);
  return { site, signedIn: false };
}
