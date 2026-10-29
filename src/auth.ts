import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  auth, extractWWWAuthenticateParams, OAuthError, UnauthorizedError,
  type AuthProvider, type AuthResult, type FetchLike, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { connectRemote, mcpUrl, RemoteError, toRemoteError, type Remote } from "./remote.js";
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

/** Home folders already checked to be private, so each is checked once per process. */
const privateHomes = new Set<string>();

/**
 * Holds refresh tokens, so it is readable by the user only, in a home folder created private. A home folder
 * made before sign-in existed (0755, say) is made private the first time tokens are written to it.
 */
function writeAuthFile(data: AuthFile): void {
  const dir = home();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!privateHomes.has(dir)) {
    if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    privateHomes.add(dir);
  }
  writeFileAtomic(authPath(), JSON.stringify(data, null, 2) + "\n", 0o600);
}

const LOCK_WAIT_MS = 10_000;
/** A token refresh holds the lock across a round trip to the site, so waiting for one allows longer. */
const REFRESH_LOCK_WAIT_MS = 60_000;
const LOCK_STALE_MS = 30_000;
/** How long each request of a token refresh may take. */
export const REFRESH_TIMEOUT_MS = 20_000;
const pause = new Int32Array(new SharedArrayBuffer(4));
/** Set while this process holds the lock for a refresh, whose own auth.json writes then run inside it. */
let heldForRefresh = false;
/** Refreshes in this process, one after another. */
let refreshQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs a read-modify-write of auth.json under an exclusive lock, so background captures refreshing tokens at
 * the same time can't drop each other's rotated tokens. Inside a refresh this process already holds it, and a
 * synchronous update can't interleave with another in the same process.
 */
function withAuthLock<T>(fn: () => T): T {
  if (heldForRefresh) return fn();
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

/**
 * Runs `fn` holding the auth.json lock throughout, waiting without blocking: a token refresh, from reading the
 * stored refresh token to saving the rotated one, so no two processes ever redeem the same refresh token.
 */
function withAuthLockAsync<T>(fn: () => Promise<T>, waitMs = REFRESH_LOCK_WAIT_MS): Promise<T> {
  const run = async (): Promise<T> => {
    fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
    const file = `${authPath()}.lock`;
    const deadline = Date.now() + waitMs;
    let lock = acquireFileLock(file, LOCK_STALE_MS);
    while (!lock) {
      // Busy, not refused: a network-kind error, so the sign-in isn't marked expired.
      if (Date.now() > deadline) throw new RemoteError(`${authPath()} is busy with another repobrain process's sign-in; try again`, "network");
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
      lock = acquireFileLock(file, LOCK_STALE_MS);
    }
    const held = lock;
    const keepFresh = setInterval(() => held.refresh(), LOCK_STALE_MS / 3);
    keepFresh.unref();
    heldForRefresh = true;
    try {
      return await fn();
    } finally {
      heldForRefresh = false;
      clearInterval(keepFresh);
      held.release();
    }
  };
  const result = refreshQueue.then(run, run);
  refreshQueue = result.catch(() => {});
  return result;
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

/** Whether `repobrain login` stored tokens for the site. */
export function isSignedIn(site: string): boolean {
  return readAuthFile().sites[site]?.tokens !== undefined;
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

/**
 * What the MCP transport signs requests with: the provider's stored access token, and on a 401 the SDK's
 * refresh, run under the auth.json lock. Inside the lock the stored tokens are read again first: when another
 * process has refreshed meanwhile, its new access token is used as it is. Without this, two background
 * captures would redeem the same refresh token, and with rotation the loser's `invalid_grant` would make the
 * SDK delete the winner's new tokens, signing the user out.
 */
export function lockedAuthProvider(provider: OAuthClientProvider, opts: { refreshTimeoutMs?: number; lockWaitMs?: number } = {}): AuthProvider {
  const timeoutMs = opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
  let sent: string | undefined;
  return {
    async token() {
      sent = (await provider.tokens())?.access_token;
      return sent;
    },
    async onUnauthorized(ctx) {
      await withAuthLockAsync(async () => {
        const stored = (await provider.tokens())?.access_token;
        if (stored !== undefined && stored !== sent) return; // refreshed by another process: retry with it
        // Every request of the refresh gets a deadline, so a site that never answers can't hold the lock.
        let timedOut = false;
        // Whether the site answered a request with an OAuth error (400 or 401), such as a refused refresh token.
        let refused = false;
        const fetchFn: FetchLike = (url, init) => {
          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
          return ctx.fetchFn(url, { ...init, signal }).then(
            (res) => {
              if (res.status === 400 || res.status === 401) refused = true;
              return res;
            },
            (e: unknown) => {
              if (timeout.aborted) timedOut = true;
              throw e;
            },
          );
        };
        const timeoutError = () => new RemoteError(`the site's sign-in server didn't answer within ${Math.round(timeoutMs / 1000)}s`, "network");
        const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
        let result: AuthResult;
        try {
          result = await auth(provider, { serverUrl: ctx.serverUrl, resourceMetadataUrl, scope, fetchFn });
        } catch (e) {
          // The SDK answers a failed refresh by starting a browser sign-in, which fails outside login.
          // A timeout is blamed only when the site never gave a real OAuth answer. A refresh token refused after
          // an earlier request timed out (and the SDK carried on) is still a sign-in to redo; the SDK then asks
          // for a browser sign-in, which this provider refuses with an UnauthorizedError.
          throw timedOut && !refused && !(e instanceof OAuthError) ? timeoutError() : e;
        }
        if (result !== "AUTHORIZED") throw timedOut && !refused ? timeoutError() : new UnauthorizedError();
      }, opts.lockWaitMs);
    },
  };
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

/**
 * Listens on 127.0.0.1 at a free port, before the flow starts, so the redirect URL is known. Only a callback
 * carrying this sign-in's state counts; any other request gets a 404 and the wait goes on.
 */
async function listenForCallback(expectedState: () => string | undefined): Promise<CallbackListener> {
  let deliver: (params: URLSearchParams) => void = () => {};
  const received = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const state = expectedState();
    if (url.pathname !== "/callback" || state === undefined || url.searchParams.get("state") !== state) {
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

/** https anywhere, or http on this machine: the only URLs handed to the system opener. */
function mayOpen(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * Opens the URL with the system's opener, ignoring failures: the URL is printed too. Returns whether the
 * opener started. Any other kind of URL is left for the user to open from the printed text.
 */
export async function openInBrowser(url: URL, spawnFn: typeof spawn = spawn): Promise<boolean> {
  if (!mayOpen(url)) return false;
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawnFn(command, [url.toString()], { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
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
  openBrowser?: (url: URL) => Promise<unknown>;
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

  let provider: FileOAuthProvider | undefined;
  const listener = await listenForCallback(() => provider?.expectedState);
  try {
    provider = new FileOAuthProvider(site, {
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
