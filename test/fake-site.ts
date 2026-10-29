import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeSite {
  base: string;
  /** Each request as "METHOD /path", with the grant type on /token requests. */
  hits: string[];
  close(): Promise<void>;
}

export interface FakeSiteOptions {
  /** The bearer tokens /api/mcp accepts; any other gets a 401 pointing at the metadata. */
  accept: string[];
  /** The /token endpoint: the response body and status for a form. */
  token: (form: URLSearchParams) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

/**
 * A stand-in for the site: protected-resource and authorization-server metadata, a token endpoint, and a
 * minimal MCP endpoint (plain JSON responses) whose tools/call returns `{"ok":true}`.
 */
export async function startFakeSite(options: FakeSiteOptions): Promise<FakeSite> {
  const hits: string[] = [];
  let base = "";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    hits.push(`${req.method} ${url.pathname}${url.pathname === "/token" ? ` ${new URLSearchParams(body).get("grant_type")}` : ""}`);
    if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
      return json(200, { resource: `${base}/api/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const { status, body: out } = await options.token(new URLSearchParams(body));
      return json(status, out);
    }
    if (url.pathname === "/api/mcp") {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!bearer || !options.accept.includes(bearer)) {
        return json(401, { error: "invalid_token" }, {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
        });
      }
      if (req.method !== "POST") return void res.writeHead(405).end();
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === "initialize"
          ? { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-site", version: "1" } }
          : msg.method === "tools/call"
            ? { content: [{ type: "text", text: '{"ok":true}' }] }
            : {};
      return json(200, { jsonrpc: "2.0", id: msg.id, result });
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
