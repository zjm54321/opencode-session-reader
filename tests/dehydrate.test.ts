import { describe, expect, test } from "bun:test";
import { dehydrate, dehydrateMessage, parseTurns, truncate } from "../src/dehydrate.js";
import type { SessionMessage } from "../src/client.js";

describe("dehydrate", () => {
  test("preserves full user prompts while bounding assistant text blocks", () => {
    const prompt = `Please implement this.\n\n${"u".repeat(2000)}`;
    const output = dehydrate([
      { type: "user", text: prompt },
      { type: "assistant", content: [{ type: "text", text: "a".repeat(1800) }, { type: "text", text: "Done." }] },
    ]);
    expect(output).toContain(prompt);
    expect(output).toContain("Done.");
    expect(output).toContain("[truncated]");
    expect(output).not.toContain("a".repeat(1501));
    expect(truncate("a".repeat(1800), 1500)).toHaveLength(1500);
    expect(truncate("short", 1500)).toBe("short");
  });

  test("replaces tool payloads, file reads and long logs with status badges", () => {
    const output = dehydrate([{ type: "assistant", content: [
      { type: "tool", name: "read", state: { status: "completed", content: [{ type: "text", text: "SECRET FILE".repeat(2000) }] } },
      { type: "tool", name: "bash", state: { status: "running", output: "VERBOSE LOG".repeat(1000) } },
      { type: "tool", name: "grep", state: { status: "error", error: { message: `Permission denied\n${"x".repeat(900)}` }, input: { huge: "hidden" } } },
    ] }]);
    expect(output).toContain("[Tool: read (completed)]");
    expect(output).toContain("[Tool: bash (running)]");
    expect(output).toContain("[Tool: grep (error)] Permission denied");
    expect(output).not.toContain("SECRET FILE");
    expect(output).not.toContain("VERBOSE LOG");
    expect(output).not.toContain("hidden");
    expect(output.length).toBeLessThan(450);
  });

  test("does not expose reasoning, provider state or attachment bodies", () => {
    const output = dehydrate([
      { type: "system", text: "SYSTEM SECRET" },
      { type: "user", text: "Look at this file", files: [{ data: "ATTACHMENT SECRET" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "REASONING SECRET" }, { type: "text", text: "Answer" }], providerState: { secret: "PROVIDER SECRET" } },
    ]);
    expect(output).toContain("Look at this file");
    expect(output).toContain("Answer");
    expect(output).not.toContain("SECRET");
  });

  test("formats compaction summaries and shell failures without raw outputs", () => {
    expect(dehydrateMessage({ type: "compaction", status: "completed", summary: "Prior work" })).toContain("Prior work");
    expect(dehydrateMessage({ type: "compaction", status: "failed", error: { data: { message: "Bad model" } } })).toContain("Bad model");
    expect(dehydrateMessage({ type: "shell", status: "completed", exit: 2, output: "huge log" })).toBe("### Shell\n\n[Tool: shell (completed)] Exit code: 2.");
    expect(dehydrate([])).toBe("");
  });

  test("supports role/parts message envelopes", () => {
    const output = dehydrate([
      { info: { role: "user" }, parts: [{ type: "text", text: "Question" }] },
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "not shown" } }, { type: "text", text: "Answer" }] },
    ]);
    expect(output).toContain("### User\n\nQuestion");
    expect(output).toContain("[Tool: read (completed)]");
    expect(output).toContain("Answer");
    expect(output).not.toContain("not shown");
  });
});

describe("parseTurns", () => {
  test("groups user-led turns in input order", () => {
    const messages: SessionMessage[] = [
      { type: "user", text: "First" },
      { type: "assistant", text: "Working" },
      { type: "assistant", text: "Done" },
      { type: "user", text: "Second" },
      { type: "assistant", text: "Next" },
    ];
    const turns = parseTurns(messages);
    expect(turns.map(turn => turn.user)).toEqual(["First", "Second"]);
    expect(turns.map(turn => turn.messages.length)).toEqual([3, 2]);
    expect(dehydrate(messages)).toContain("## Turn 2");
    expect(messages).toHaveLength(5);
  });

  test("retains partial leading turns and consecutive user prompts", () => {
    const turns = parseTurns([{ type: "assistant", text: "Earlier" }, { type: "user", text: "One" }, { type: "user", text: "Two" }]);
    expect(turns.map(turn => turn.user)).toEqual([undefined, "One", "Two"]);
    expect(dehydrate(turns[0]!.messages)).toContain("Earlier");
    expect(parseTurns([])).toEqual([]);
  });
});
