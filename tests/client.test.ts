import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOptions, OpenCodeClient, readServiceConfig } from "../src/client.js";

let directory: string;
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "session-reader-")); });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

async function serve(handler: (request: Request) => Response | Promise<Response>, timeoutMs?: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  await writeFile(join(directory, "service.json"), JSON.stringify({ port: server.port, password: "test-password" }));
  return new OpenCodeClient({ configDirectory: directory, timeoutMs });
}

describe("service configuration", () => {
  test("prefers production and falls back to service.json only when absent", async () => {
    await writeFile(join(directory, "service.json"), JSON.stringify({ port: 1234, password: "dev" }));
    expect(await readServiceConfig(directory)).toEqual({ port: 1234, password: "dev" });
    await writeFile(join(directory, "service-prod.json"), JSON.stringify({ port: 5678, password: "prod", hostname: "0.0.0.0" }));
    expect(await readServiceConfig(directory)).toEqual({ port: 5678, password: "prod" });
  });

  test("reports missing, invalid JSON, invalid ports and missing passwords", async () => {
    await expect(readServiceConfig(directory)).rejects.toThrow("Start the OpenCode background service first");
    await writeFile(join(directory, "service-prod.json"), "{secret-content");
    await expect(readServiceConfig(directory)).rejects.toThrow("Invalid JSON");
    for (const config of [{ port: 0, password: "x" }, { port: 65536, password: "x" }, { port: "1234", password: "x" }, { port: 1234 }, null]) {
      await writeFile(join(directory, "service-prod.json"), JSON.stringify(config));
      await expect(readServiceConfig(directory)).rejects.toThrow("expected port");
    }
  });
});

describe("client requests", () => {
  test("formats options with correct escaping and no undefined values", () => {
    const query = formatOptions({ search: "one & two", directory: "/work/my project", cursor: "a+/=", order: "asc", limit: 10, absent: undefined, empty: "" });
    expect(Object.fromEntries(query)).toEqual({ search: "one & two", directory: "/work/my project", cursor: "a+/=", order: "asc", limit: "10", empty: "" });
    expect(query.toString()).toContain("cursor=a%2B%2F%3D");
    expect(query.has("absent")).toBe(false);
  });

  test("calls every V2 endpoint with basic authentication and typed envelopes", async () => {
    const requests: { path: string; query: Record<string, string>; auth: string | null; method: string }[] = [];
    const client = await serve(request => {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.get("authorization"), method: request.method });
      return Response.json({ data: [], cursor: { next: "next-page" } });
    });
    expect((await client.listSessions({ search: "fix & ship", directory: "/home/test project", limit: 5, order: "desc", cursor: "a+/=" })).cursor.next).toBe("next-page");
    await client.getSession("ses_example");
    await client.getSessionMessages({ sessionID: "ses_example", limit: 7, order: "asc", cursor: "message-cursor", type: "assistant" });
    await client.getSessionDiff({ sessionID: "ses_example" });
    await client.getSessionContext("ses_example");
    expect(requests.map(request => request.path)).toEqual(["/api/session", "/api/session/ses_example", "/api/session/ses_example/message", "/api/session/ses_example/diff", "/api/session/ses_example/context"]);
    expect(requests[0]!.query).toEqual({ search: "fix & ship", directory: "/home/test project", limit: "5", order: "desc", cursor: "a+/=" });
    expect(requests[2]!.query).toEqual({ limit: "7", order: "asc", cursor: "message-cursor", type: "assistant" });
    expect(requests.every(request => request.method === "GET" && request.auth === `Basic ${Buffer.from("opencode:test-password").toString("base64")}`)).toBe(true);
  });

  test("encodes session path segments and omits unspecified options", async () => {
    const paths: string[] = [];
    const client = await serve(request => { paths.push(new URL(request.url).pathname + new URL(request.url).search); return Response.json({ data: [] }); });
    await client.listSessions();
    await client.getSession("ses_with/slash ?");
    expect(paths).toEqual(["/api/session", "/api/session/ses_with%2Fslash%20%3F"]);
    expect(() => client.getSession(" ")).toThrow("sessionID must not be empty");
  });

  test("formats HTTP and JSON errors without leaking credentials", async () => {
    const client = await serve(() => new Response("test-password is incorrect", { status: 401, statusText: "Unauthorized" }));
    await expect(client.listSessions()).rejects.toThrow("HTTP 401 Unauthorized: [redacted] is incorrect");
    await expect(client.listSessions()).rejects.toThrow("Check the OpenCode service credentials");
    const invalid = await serve(() => new Response("not-json"));
    await expect(invalid.listSessions()).rejects.toThrow("The service returned invalid JSON");
  });

  test("bounds error snippets", async () => {
    const client = await serve(() => new Response("x".repeat(5000), { status: 500 }));
    const message = await client.listSessions().catch((error: Error) => error.message);
    expect(typeof message === "string" && message.length < 450).toBe(true);
  });

  test("times out requests and clears the timeout on completion", async () => {
    const client = await serve(async () => { await Bun.sleep(100); return Response.json({ data: [] }); }, 10);
    await expect(client.listSessions()).rejects.toThrow("timed out after 10ms");
    expect(() => new OpenCodeClient({ timeoutMs: 0 })).toThrow("positive finite");
  });

  test("reports network failures and reloads service config after restart", async () => {
    const client = await serve(() => Response.json({ data: [], cursor: {} }));
    await client.listSessions();
    const replacement = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [], cursor: { next: "restarted" } }) });
    servers.push(replacement);
    await writeFile(join(directory, "service.json"), JSON.stringify({ port: replacement.port, password: "new" }));
    expect((await client.listSessions()).cursor.next).toBe("restarted");
    await replacement.stop(true);
    await expect(client.listSessions()).rejects.toThrow("OpenCode GET /api/session failed:");
  });
});
