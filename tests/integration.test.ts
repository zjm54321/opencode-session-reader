import { test, expect } from "bun:test";
import plugin from "../src/index.js";

test("live integration with OpenCode background service", async () => {
  const tools: Record<string, any> = {};

  const mockCtx = {
    location: { directory: "/home/ming" },
    tool: {
      transform: async (cb: (editor: any) => void) => {
        const editor = {
          add: (def: any) => {
            tools[def.name] = def;
          },
        };
        cb(editor);
        return { dispose: () => {} };
      },
    },
  };

  const cleanup = await plugin.setup(mockCtx as any);
  expect(tools.session_list).toBeDefined();
  expect(tools.session_read).toBeDefined();
  expect(tools.session_diff).toBeDefined();

  // 1. Test session_list
  const listResult = await tools.session_list.execute({ limit: 5 });
  expect(listResult.content).toBeDefined();
  const listParsed = JSON.parse(listResult.content.split("\n\nPagination:")[0]);
  expect(Array.isArray(listParsed)).toBe(true);
  expect(listParsed.length).toBeGreaterThan(0);
  console.log("Live session_list returned:", listParsed.length, "sessions. Sample ID:", listParsed[0].id);

  // 2. Test session_read on the first session
  const targetId = listParsed[0].id;
  const readSummary = await tools.session_read.execute({
    sessionID: targetId,
    mode: "summary",
    limit: 3,
  });
  expect(readSummary.content).toContain(targetId);
  console.log("Live session_read summary returned length:", readSummary.content.length);

  // 3. Test session_read in recent mode
  const readRecent = await tools.session_read.execute({
    sessionID: targetId,
    mode: "recent",
    limit: 2,
  });
  expect(readRecent.content).toBeDefined();
  console.log("Live session_read recent returned length:", readRecent.content.length);

  // 4. Test session_diff
  const diffResult = await tools.session_diff.execute({ sessionID: targetId });
  expect(diffResult.content).toBeDefined();
  console.log("Live session_diff returned:", diffResult.content.slice(0, 100));

  if (typeof cleanup === "function") {
    await cleanup();
  }
});
