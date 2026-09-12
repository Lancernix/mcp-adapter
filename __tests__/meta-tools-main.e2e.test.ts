// meta-tools-main.e2e.test.ts - 4 个元工具的对外主链路
//
// 覆盖：元工具暴露面 / 冷启动体检写缓存 / search 的命中、别名与兜底 /
//      limit 精确生效 / list / describe / search→execute 闭环 /
//      结果原样透传 / 业务失败与断连引导的区分

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  FAKE_TOOLS,
  fakeServer,
  META_TOOL_NAMES,
  startAdapter,
  textOf,
  waitForCache,
} from "./e2e-harness.js";
import { waitFor } from "./helpers.js";

/** 从搜索结果里数出实际返回的工具条数（分组标题形如 `### demo (3 matches)`） */
function countMatches(text: string): number {
  return [...text.matchAll(/\((\d+) (?:matches|tools)\)/g)].reduce(
    (sum, m) => sum + Number(m[1]),
    0,
  );
}

describe("元工具主链路 (e2e)", () => {
  let adapter: AdapterHandle;

  before(async () => {
    adapter = await startAdapter({
      version: 1,
      settings: { startupMetadataCheck: true, toolSearchLimit: 10 },
      mcpServers: {
        demo: fakeServer({ aliases: ["演示服务", "demo server"] }),
      },
    });
    await waitForCache(adapter.home, ["demo"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("对外只暴露 4 个元工具，底层 4 个真实工具全部被拦截", async () => {
    const { tools } = await adapter.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      META_TOOL_NAMES,
      "客户端不应该看到底层真实工具，只应看到 4 个元工具",
    );
    // 底层其实有 6 个工具，验证它们确实没有泄漏到对外列表
    const listed = await callTool(adapter.client, "list_tools", {
      server: "demo",
    });
    assert.match(
      textOf(listed),
      new RegExp(`共有 ${FAKE_TOOLS.length} 个工具`),
    );
  });

  it("冷启动自动完成 metadata 体检并写入 cache.json", async () => {
    const cache = JSON.parse(
      fs.readFileSync(path.join(adapter.home, "cache.json"), "utf-8"),
    ) as { servers: Record<string, { tools: Array<{ name: string }> }> };

    assert.deepEqual(
      cache.servers.demo.tools.map((tool) => tool.name).sort(),
      [...FAKE_TOOLS].sort(),
    );
  });

  it("启动日志明确写出体检范围与强制重拉的服务", async () => {
    const ready = await waitFor(() =>
      adapter.logs().includes("[Bootstrap] 启动期 metadata 体检开始"),
    );
    assert.ok(ready, `未看到体检日志，实际 stderr：\n${adapter.logs()}`);

    const logs = adapter.logs();
    assert.match(logs, /1 个服务待刷新 —— demo/);
    assert.match(logs, /\[Bootstrap\] 正在刷新 \[demo\]（缓存缺失或已失效）/);
    assert.match(
      logs,
      new RegExp(
        `✓ \\[demo\\] metadata 刷新完成，发现 ${FAKE_TOOLS.length} 个工具`,
      ),
    );
  });

  it("search_tools 按功能关键词命中，并返回 inputSchema 与匹配依据", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo text",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /demo\.echo/);
    assert.match(text, /inputSchema/);
    assert.match(text, /匹配依据/);
    assert.match(text, /执行建议/);
  });

  it("search_tools 用中文别名也能定位到服务", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "演示服务",
    });
    const text = textOf(result);

    assert.match(text, /已解析为 server "demo"/);
    assert.match(text, /demo\.echo/);
  });

  it("search_tools 的 server hint 无法匹配时回退全局搜索而不是报错", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "echo",
      server: "完全不存在的服务名",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /未匹配到已配置服务/);
    // 仍应通过把 hint 拼进 query 的方式完成全局搜索
    assert.match(text, /demo\.echo/);
  });

  it("search_tools 无结果时返回可用 server 列表作为兜底", async () => {
    const result = await callTool(adapter.client, "search_tools", {
      query: "zzzz_完全不相关的东西_zzzz",
    });
    const text = textOf(result);

    assert.equal(result.isError, undefined);
    assert.match(text, /暂未匹配到/);
    assert.match(text, /可用 server 列表/);
    assert.match(text, /- demo \(aliases: 演示服务, demo server\)/);
  });

  it("search_tools 支持 limit 控制返回数量", async () => {
    // 用一个必然匹配不到功能词的 query，走"已识别 server 但无强匹配"的浏览兜底：
    // 该路径会返回该服务的全部工具，条数只受 limit 约束，断言可以做到精确。
    const browseWithLimit = async (limit: number) => {
      const result = await callTool(adapter.client, "search_tools", {
        query: "zzz-这个关键词一定匹配不到任何工具",
        server: "demo",
        limit,
      });
      assert.equal(result.isError, undefined, "limit 应当被正常受理");
      return countMatches(textOf(result));
    };

    const one = await browseWithLimit(1);
    const three = await browseWithLimit(3);

    assert.equal(one, 1, `limit=1 应只返回 1 条，实际 ${one} 条`);
    assert.equal(three, 3, `limit=3 应返回 3 条，实际 ${three} 条`);

    // 兜底路径最多只能给出该服务的全部工具数，limit 再大也不会超
    assert.ok(
      three <= FAKE_TOOLS.length,
      `返回条数不应超过服务实际工具数（${FAKE_TOOLS.length}）`,
    );
  });

  it("list_tools 返回工具名目录，且刻意不带 schema", async () => {
    const result = await callTool(adapter.client, "list_tools", {
      server: "demo",
    });
    const text = textOf(result);

    assert.match(text, new RegExp(`demo 共有 ${FAKE_TOOLS.length} 个工具`));
    for (const name of FAKE_TOOLS) {
      assert.match(text, new RegExp(`\\b${name}\\b`));
    }
    assert.doesNotMatch(text, /inputSchema/);
    assert.match(text, /不包含描述和参数/);
  });

  it("describe_tool 返回指定工具的完整 inputSchema", async () => {
    const result = await callTool(adapter.client, "describe_tool", {
      tool: "demo.echo",
    });
    const text = textOf(result);

    assert.match(text, /工具全名: \*\*demo\.echo\*\*/);
    assert.match(text, /"text"/);
  });

  it("describe_tool 找不到工具时给出可行动的引导", async () => {
    const result = await callTool(adapter.client, "describe_tool", {
      tool: "demo.不存在的工具",
    });
    assert.match(textOf(result), /未能定位到工具/);
    assert.match(textOf(result), /search_tools/);
  });

  it("search → execute 两步闭环可以真正调用到底层工具", async () => {
    const search = await callTool(adapter.client, "search_tools", {
      query: "echo text",
    });
    // 从 search 结果里确认拿到的是可直接执行的 qualifiedName
    assert.match(textOf(search), /demo\.echo/);

    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: "hello" },
    });
    assert.equal(executed.isError, undefined);
    assert.equal(textOf(executed), "echo:hello");
  });

  it("execute_tool 支持裸工具名（不带 server 前缀）", async () => {
    const executed = await callTool(adapter.client, "execute_tool", {
      tool: "echo",
      arguments: { text: "bare" },
    });
    assert.equal(textOf(executed), "echo:bare");
  });

  it("execute_tool 对未知工具返回可行动的 isError，而不是静默失败", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "完全不存在的工具",
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /未能定位到工具/);
    assert.match(textOf(result), /search_tools/);
  });

  it("execute_tool 把底层返回的原始结果原样透传（长文本不截断、特殊字符不转义）", async () => {
    // 刻意构造长文本 + 需要转义的字符：验证网关没有做任何加工
    const payload = [
      "中文内容",
      "换行\n第二行",
      '引号"与反斜杠\\',
      "x".repeat(5000),
    ].join("|");

    const result = await callTool(adapter.client, "execute_tool", {
      tool: "demo.echo",
      arguments: { text: payload },
    });

    assert.equal(result.isError, undefined);
    const text = textOf(result);
    assert.equal(
      text.length,
      payload.length + "echo:".length,
      `长文本必须原样透传：期望 ${payload.length + 5} 字符，实际 ${text.length}`,
    );
    assert.ok(text.includes("x".repeat(5000)), "长文本不得被截断");
    assert.ok(text.includes("换行\n第二行"), "换行符不得被转义或吞掉");
    assert.ok(text.includes('引号"与反斜杠\\'), "引号与反斜杠不得被转义");
  });

  it("底层工具的业务失败不会被误判成网关断连", async () => {
    // 错误文案里刻意带上 "connection closed"：如果分类靠匹配文本，
    // 这里就会被套上断连引导，给出完全错误的处置建议
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "demo.fail",
      arguments: { message: "database connection closed unexpectedly" },
    });

    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(
      text,
      /database connection closed unexpectedly/,
      "业务错误应原样透传",
    );
    assert.doesNotMatch(
      text,
      /与 \[demo\] 的连接已断开/,
      "业务失败不该被套用断连引导",
    );
  });
});
