// SPDX-License-Identifier: GPL-3.0-or-later

import type { MessagePart, SessionMessage } from "./client.js";

export interface Turn {
  user?: string;
  messages: SessionMessage[];
}

export function truncate(text: string, limit: number): string {
  const marker = "\n… [truncated]";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - marker.length))}${marker.slice(0, limit)}`;
}

function messageType(message: SessionMessage): string | undefined {
  return message.type ?? message.role ?? message.info?.role;
}

function textBlocks(message: SessionMessage): string[] {
  if (typeof message.text === "string") return [message.text];
  if (typeof message.content === "string") return [message.content];
  return (message.content ?? message.parts ?? []).flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []);
}

/** Parse chronological messages into prompt-led turns, retaining partial leading turns. */
export function parseTurns(messages: readonly SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (messageType(message) === "user") {
      turns.push({ user: textBlocks(message).join("\n\n").trim(), messages: [message] });
      continue;
    }
    if (!turns.length) turns.push({ messages: [] });
    turns[turns.length - 1]!.messages.push(message);
  }
  return turns;
}

function errorSnippet(error: unknown): string {
  if (typeof error === "string") return truncate(error.replace(/\s+/g, " ").trim(), 200);
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return errorSnippet(record.message ?? record.error ?? record.data);
  }
  return "";
}

function toolBadge(part: MessagePart): string {
  const status = part.state?.status ?? "unknown";
  const name = truncate((part.name ?? part.tool ?? "unknown").replace(/[\r\n\[\]]/g, " "), 80);
  const error = status === "error" || status === "failed" ? errorSnippet(part.state?.error) : "";
  return `[Tool: ${name} (${status})]${error ? ` ${error}` : ""}`;
}

export function dehydrateMessage(message: SessionMessage): string {
  const type = messageType(message);
  if (type === "user") return `### User\n\n${textBlocks(message).join("\n\n").trim()}`;
  if (type === "assistant") {
    const parts = Array.isArray(message.content) ? message.content : message.parts;
    const blocks = parts
      ? parts.flatMap(part => part.type === "tool" ? [toolBadge(part)] : part.type === "text" && part.text?.trim() ? [truncate(part.text.trim(), 1500)] : [])
      : textBlocks(message).filter(text => text.trim()).map(text => truncate(text.trim(), 1500));
    if (message.error) blocks.push(`[Assistant error] ${errorSnippet(message.error)}`);
    return blocks.length ? `### Assistant\n\n${blocks.join("\n\n")}` : "";
  }
  if (type === "compaction") {
    if (message.status === "failed") return `### Compaction\n\n[Failed] ${errorSnippet(message.error)}`;
    return message.summary ? `### Compaction summary\n\n${truncate(message.summary.trim(), 1500)}` : "";
  }
  if (type === "shell") {
    const error = message.exit && message.exit !== 0 ? ` Exit code: ${message.exit}.` : "";
    return `### Shell\n\n[Tool: shell (${message.status ?? "unknown"})]${error}`;
  }
  // Provider state, reasoning, system injections and attachment bodies are not conversation text.
  return "";
}

/** Tool payloads are deliberately never serialized, even if an individual output is small. */
export function dehydrate(messages: readonly SessionMessage[]): string {
  return parseTurns(messages).flatMap((turn, index) => {
    const blocks = turn.messages.map(dehydrateMessage).filter(Boolean);
    return blocks.length ? [`## Turn ${index + 1}\n\n${blocks.join("\n\n")}`] : [];
  }).join("\n\n---\n\n");
}
