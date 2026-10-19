// SPDX-License-Identifier: GPL-3.0-or-later

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Order = "asc" | "desc";
export interface Cursor { previous?: string; next?: string }
export interface Page<T> { data: T[]; cursor: Cursor }
export interface Data<T> { data: T }

/** JSON wire types, not the SDK's decoded Effect DateTime values. */
export interface SessionInfo {
  id: string;
  title: string;
  parentID?: string;
  location?: { directory: string; workspaceID?: string };
  directory?: string;
  time?: { created: number; updated: number; archived?: number };
  [key: string]: unknown;
}

export interface MessagePart {
  type: string;
  text?: string;
  name?: string;
  tool?: string;
  state?: { status: string; error?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SessionMessage {
  id?: string;
  type?: string;
  role?: string;
  text?: string;
  content?: string | MessagePart[];
  parts?: MessagePart[];
  info?: { id?: string; role?: string };
  status?: string;
  summary?: string;
  recent?: string;
  error?: unknown;
  exit?: number;
  [key: string]: unknown;
}

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface ListSessionsOptions {
  search?: string;
  limit?: number;
  directory?: string;
  cursor?: string;
  order?: Order;
}

export interface SessionMessagesOptions {
  sessionID: string;
  limit?: number;
  order?: Order;
  cursor?: string;
  type?: string;
}

export interface ServiceConfig { port: number; password: string }

export async function readServiceConfig(configDirectory = join(homedir(), ".config", "opencode")): Promise<ServiceConfig> {
  for (const filename of ["service-prod.json", "service.json"]) {
    const path = join(configDirectory, filename);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read OpenCode service configuration at ${path}.`);
    }
    let config: Partial<ServiceConfig> | null;
    try {
      config = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON in OpenCode service configuration at ${path}.`);
    }
    if (!config || !Number.isInteger(config.port) || config.port! < 1 || config.port! > 65535 || typeof config.password !== "string") {
      throw new Error(`Invalid OpenCode service configuration at ${path}: expected port (1–65535) and password (string).`);
    }
    return { port: config.port!, password: config.password };
  }
  throw new Error(`OpenCode service configuration not found in ${configDirectory} (service-prod.json or service.json). Start the OpenCode background service first.`);
}

/** Omits only absent values; URLSearchParams safely encodes paths, searches and cursors. */
export function formatOptions(options: Record<string, string | number | undefined>): URLSearchParams {
  return new URLSearchParams(Object.entries(options).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]));
}

export interface ClientOptions {
  configDirectory?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class OpenCodeClient {
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(private readonly options: ClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be a positive finite number.");
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  listSessions(opts: ListSessionsOptions = {}): Promise<Page<SessionInfo>> {
    return this.get("/api/session", { ...opts });
  }

  getSession(sessionID: string): Promise<Data<SessionInfo>> {
    return this.get(this.sessionPath(sessionID));
  }

  getSessionMessages(opts: SessionMessagesOptions): Promise<Page<SessionMessage>> {
    const { sessionID, ...query } = opts;
    return this.get(`${this.sessionPath(sessionID)}/message`, query);
  }

  getSessionDiff(opts: { sessionID: string }): Promise<Data<FileDiff[]>> {
    return this.get(`${this.sessionPath(opts.sessionID)}/diff`);
  }

  getSessionContext(sessionID: string): Promise<Data<SessionMessage[]>> {
    return this.get(`${this.sessionPath(sessionID)}/context`);
  }

  private sessionPath(sessionID: string): string {
    if (!sessionID.trim()) throw new Error("sessionID must not be empty.");
    return `/api/session/${encodeURIComponent(sessionID)}`;
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    // Reload on each request so a restarted service's port/password is picked up.
    const config = await readServiceConfig(this.options.configDirectory);
    const url = new URL(path, `http://127.0.0.1:${config.port}`);
    url.search = formatOptions(query).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const redact = (value: string) => {
      const authorization = Buffer.from(`opencode:${config.password}`).toString("base64");
      const clean = value.replaceAll(authorization, "[redacted]");
      return config.password ? clean.replaceAll(config.password, "[redacted]") : clean;
    };
    try {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}`,
        },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        const text = redact(await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
        const hint = response.status === 401 || response.status === 403 ? " Check the OpenCode service credentials." : "";
        throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}.${hint}`);
      }
      try {
        return await response.json() as T;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new Error("The service returned invalid JSON.");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`OpenCode GET ${path} timed out after ${this.timeoutMs}ms.`);
      throw new Error(`OpenCode GET ${path} failed: ${redact(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
