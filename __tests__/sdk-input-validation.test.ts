// sdk-input-validation.test.ts - Regression test for the documented behavior
// that tool input limits are enforced by the SDK's input validation.
//
// README states that list_tools limit > 500 "会被参数校验拒绝" (rejected, not
// silently truncated). The MCP SDK validates tool arguments against the
// registered zod schema at call time (server/mcp.js validateToolInput) and
// returns InvalidParams (-32602) before our handler runs. The handler's
// Math.min(cap) only matters for the server-side tool-count cap. This suite
// locks that behavior with a real InMemoryTransport round-trip.

import assert from "node:assert";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// 与 index.ts 中 ListToolsArgsSchema 的 limit 字段保持一致
const ListToolsArgsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

interface Probe {
  client: Client;
  cleanup: () => Promise<void>;
  getHandlerCalls: () => number;
}

async function setupProbe(): Promise<Probe> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const server = new McpServer({ name: "test-srv", version: "1.0.0" });
  let handlerCalls = 0;
  server.registerTool(
    "list_tools",
    { inputSchema: ListToolsArgsSchema },
    async () => {
      handlerCalls++;
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
    getHandlerCalls: () => handlerCalls,
  };
}

describe("SDK 入参校验（list_tools limit 语义）", () => {
  it("limit > 500 被参数校验拒绝，handler 不会执行", async () => {
    const probe = await setupProbe();
    try {
      const result = (await probe.client.callTool({
        name: "list_tools",
        arguments: { limit: 501 },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };

      assert.equal(result.isError, true);
      const text = result.content?.map((c) => c.text ?? "").join("");
      assert.match(text ?? "", /Invalid arguments/);
      assert.match(text ?? "", /500/);
      assert.equal(probe.getHandlerCalls(), 0);
    } finally {
      await probe.cleanup();
    }
  });

  it("limit = 500 正常进入 handler", async () => {
    const probe = await setupProbe();
    try {
      const result = (await probe.client.callTool({
        name: "list_tools",
        arguments: { limit: 500 },
      })) as { isError?: boolean };

      assert.notEqual(result.isError, true);
      assert.equal(probe.getHandlerCalls(), 1);
    } finally {
      await probe.cleanup();
    }
  });

  it("不传 limit 时使用 handler 内默认值（默认 500，由 Math.min 兜底）", async () => {
    const probe = await setupProbe();
    try {
      const result = (await probe.client.callTool({
        name: "list_tools",
        arguments: {},
      })) as { isError?: boolean };

      assert.notEqual(result.isError, true);
      assert.equal(probe.getHandlerCalls(), 1);
    } finally {
      await probe.cleanup();
    }
  });
});
