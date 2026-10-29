import http from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTransport, SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { connectRemote, RemoteError, toRemoteError, type Remote } from "../src/remote.js";

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

  it("classifies fetch failures and other HTTP errors as network", () => {
    expect(toRemoteError(new TypeError("fetch failed")).kind).toBe("network");
    expect(toRemoteError(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "502", { status: 502 })).kind).toBe("network");
  });

  it("keeps a RemoteError as it is", () => {
    const e = new RemoteError("x", "tool");
    expect(toRemoteError(e)).toBe(e);
  });
});
