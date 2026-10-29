import {
  Client, OAuthClientFlowError, OAuthError, ProtocolError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError,
  type OAuthClientProvider, type Transport,
} from "@modelcontextprotocol/client";
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

const CLIENT_INFO = { name: "repobrain", version: "0.3.0" };

/** The site's MCP endpoint, e.g. https://repobrain.com/api/mcp. */
export function mcpUrl(site: string): URL {
  return new URL("api/mcp", site.endsWith("/") ? site : `${site}/`);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sorts an SDK, OAuth or fetch failure into one of the three kinds. */
export function toRemoteError(e: unknown): RemoteError {
  if (e instanceof RemoteError) return e;
  if (e instanceof UnauthorizedError || e instanceof OAuthError || e instanceof OAuthClientFlowError) {
    const m = messageOf(e);
    return new RemoteError(m.includes("repobrain login") ? m : `not signed in to the site, or the sign-in expired: run repobrain login (${m})`, "auth");
  }
  if (e instanceof SdkHttpError && (e.status === 401 || e.status === 403)) {
    return new RemoteError(`the site refused the sign-in: run repobrain login (${messageOf(e)})`, "auth");
  }
  if (e instanceof ProtocolError) return new RemoteError(messageOf(e), "tool");
  return new RemoteError(`could not reach the site: ${messageOf(e)}`, "network");
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
    throw toRemoteError(e);
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
