import {
  Client, OAuthClientFlowError, OAuthError, ProtocolError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError,
  type OAuthClientProvider, type Transport,
} from "@modelcontextprotocol/client";
import pkg from "../package.json" with { type: "json" };
import { FileOAuthProvider } from "./auth.js";

/** The site's tools, called over MCP with the user's stored OAuth tokens. */
export interface Remote {
  /** Calls a tool and parses the JSON text the site returns in its first content item. */
  call<T>(tool: string, args: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

/** `auth`: not signed in, or the site refused the token. `network`: the site couldn't be reached. `tool`: the tool failed. */
export type RemoteErrorKind = "auth" | "network" | "tool";

export class RemoteError extends Error {
  constructor(message: string, readonly kind: RemoteErrorKind) {
    super(message);
    this.name = "RemoteError";
  }
}

/** How the plugin introduces itself to the site. esbuild inlines the version from package.json. */
export const CLIENT_INFO = { name: "repobrain", version: pkg.version };

/** The site's MCP endpoint, e.g. https://repobrain.com/api/mcp. */
export function mcpUrl(site: string): URL {
  return new URL("api/mcp", site.endsWith("/") ? site : `${site}/`);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Socket-level codes on a failed fetch's cause (Node's and undici's). */
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

/** A failure to reach the site at all: no connection, a timeout, or the site's own 5xx. */
function isNetworkFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  if (e instanceof SdkHttpError) return !(e.status > 0) || e.status >= 500;
  const code = (e.cause as { code?: unknown } | undefined)?.code;
  return e instanceof TypeError && typeof code === "string" && NETWORK_CODES.has(code);
}

/**
 * Sorts an SDK, OAuth or fetch failure into one of the three kinds. Errors that are neither an auth failure nor
 * a failure to reach the site get `fallback`: "auth" while connecting or signing in, where they come from the
 * OAuth flow, and "tool" for a tool call.
 */
export function toRemoteError(e: unknown, fallback: "auth" | "tool" = "tool"): RemoteError {
  if (e instanceof RemoteError) return e;
  if (e instanceof UnauthorizedError || e instanceof OAuthError || e instanceof OAuthClientFlowError) {
    const m = messageOf(e);
    return new RemoteError(m.includes("repobrain login") ? m : `not signed in to the site, or the sign-in expired: run repobrain login (${m})`, "auth");
  }
  if (e instanceof SdkHttpError && (e.status === 401 || e.status === 403)) {
    return new RemoteError(`the site refused the sign-in: run repobrain login (${messageOf(e)})`, "auth");
  }
  if (e instanceof ProtocolError) return new RemoteError(messageOf(e), "tool");
  if (isNetworkFailure(e)) return new RemoteError(`could not reach the site: ${messageOf(e)}`, "network");
  if (fallback === "auth") return new RemoteError(`sign-in failed: ${messageOf(e)}; run repobrain login`, "auth");
  return new RemoteError(messageOf(e), "tool");
}

function firstText(result: { content?: unknown }): string | null {
  const first = Array.isArray(result.content) ? (result.content[0] as { type?: unknown; text?: unknown } | undefined) : undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : null;
}

/**
 * Connects to the site's MCP endpoint (`<site>/api/mcp`). Tests pass an in-memory `transport`; otherwise it
 * speaks Streamable HTTP, signing requests with `authProvider`, by default the tokens `repobrain login` stored.
 */
export async function connectRemote(site: string, deps: { transport?: Transport; authProvider?: OAuthClientProvider } = {}): Promise<Remote> {
  const transport = deps.transport ?? new StreamableHTTPClientTransport(mcpUrl(site), { authProvider: deps.authProvider ?? new FileOAuthProvider(site) });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport);
  } catch (e) {
    await client.close().catch(() => {});
    throw toRemoteError(e, "auth");
  }
  return {
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      let result;
      try {
        result = await client.callTool({ name: tool, arguments: args });
      } catch (e) {
        throw toRemoteError(e);
      }
      const text = firstText(result);
      if (result.isError) throw new RemoteError(text ?? `${tool} failed`, "tool");
      if (text === null) throw new RemoteError(`${tool} returned no text`, "tool");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new RemoteError(`${tool} returned text that isn't JSON`, "tool");
      }
    },
    close: () => client.close(),
  };
}
