// meta-tools-env-cwd.e2e.test.ts - 子进程环境与工作目录的真实生效
//
// 覆盖：config.env 显式传递 / inheritEnv 默认继承宿主环境 /
//      inheritEnv=false 的隔离与 SDK 安全默认集（PATH/HOME）保留 /
//      cwd 真实改变子进程工作目录

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  type AdapterHandle,
  callTool,
  fakeServer,
  flushAdapters,
  startAdapter,
  textOf,
  waitForCache,
} from "./e2e-harness.js";
import { trackTmpDir } from "./helpers.js";

after(flushAdapters);

describe("元工具 - env / inheritEnv / cwd (e2e)", () => {
  const HOST_PROBE = "MCP_ADAPTER_E2E_HOST_PROBE";
  let adapter: AdapterHandle;
  let cwdTarget = "";

  before(async () => {
    cwdTarget = fs.realpathSync(
      trackTmpDir(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adapter-cwd-"))),
    );

    adapter = await startAdapter(
      ({ spawnLog }) => ({
        version: 1,
        settings: { startupMetadataCheck: true },
        mcpServers: {
          inheritOn: fakeServer({
            env: { FAKE_SPAWN_LOG: spawnLog, E2E_EXPLICIT: "explicit-on" },
          }),
          inheritOff: fakeServer({
            inheritEnv: false,
            env: { FAKE_SPAWN_LOG: spawnLog, E2E_EXPLICIT: "explicit-off" },
          }),
          withCwd: fakeServer({
            cwd: cwdTarget,
            env: { FAKE_SPAWN_LOG: spawnLog },
          }),
        },
      }),
      { [HOST_PROBE]: "host-value" },
    );

    await waitForCache(adapter.home, ["inheritOn", "inheritOff", "withCwd"]);
  });

  after(async () => {
    await adapter.stop();
  });

  it("config.env 中显式配置的变量会传给子进程", async () => {
    const on = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOn.env",
      arguments: { name: "E2E_EXPLICIT" },
    });
    assert.equal(textOf(on), "env:E2E_EXPLICIT=explicit-on");

    const off = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOff.env",
      arguments: { name: "E2E_EXPLICIT" },
    });
    assert.equal(
      textOf(off),
      "env:E2E_EXPLICIT=explicit-off",
      "inheritEnv=false 时显式 env 仍然必须生效",
    );
  });

  it("inheritEnv 默认为 true，子进程能读到宿主进程的环境变量", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOn.env",
      arguments: { name: HOST_PROBE },
    });
    assert.equal(textOf(result), `env:${HOST_PROBE}=host-value`);
  });

  it("inheritEnv=false 时子进程读不到宿主任意变量", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "inheritOff.env",
      arguments: { name: HOST_PROBE },
    });
    assert.equal(
      textOf(result),
      `env:${HOST_PROBE}=<unset>`,
      "inheritEnv=false 应隔离宿主任意变量",
    );
  });

  it("inheritEnv=false 仍保留 SDK 的跨平台安全默认集（PATH / HOME）", async () => {
    for (const key of ["PATH", "HOME"]) {
      const result = await callTool(adapter.client, "execute_tool", {
        tool: "inheritOff.env",
        arguments: { name: key },
      });
      assert.doesNotMatch(
        textOf(result),
        /<unset>/,
        `inheritEnv=false 不应把 ${key} 也一起剥掉，否则子进程无法正常工作`,
      );
    }
  });

  it("cwd 配置会真正改变子进程的工作目录", async () => {
    const result = await callTool(adapter.client, "execute_tool", {
      tool: "withCwd.cwd",
    });
    assert.equal(textOf(result), `cwd:${cwdTarget}`);
  });
});
