// config-legacy-migration.test.ts - 旧配置字段的兼容与落盘迁移
//
// metadataBootstrap("background"|"off") 已更名为 startupMetadataCheck(boolean)。
// 这里锁定兼容层的三条契约：
//   1. 读：旧字段能被识别并归一化成新字段，运行期对象里不再同时存在两个同义字段
//   2. 提示：迁移动作产生可观测的提示（由 index.ts 写成 [Config-Migration] 日志）
//   3. 写：任何一次落盘都只产出新字段，旧字段不会回流到 config.json

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  loadConfig,
  saveConfig,
  takeConfigMigrationNotes,
} from "../src/config-manager.js";

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-adapter-cfg-home-"));
  process.env.MCP_ADAPTER_HOME = dir;
  // 清掉上一轮遗留的提示，保证每个用例看到的是自己的迁移结果
  takeConfigMigrationNotes();
  return dir;
}

function writeRawConfig(dir: string, config: unknown): void {
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

function baseConfig(settings: Record<string, unknown>) {
  return { version: 1, settings, mcpServers: {} };
}

describe("配置迁移 - metadataBootstrap → startupMetadataCheck", () => {
  it('旧值 "off" 归一化为 startupMetadataCheck=false，并删除旧字段', () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ metadataBootstrap: "off" }));

    const config = loadConfig();

    assert.equal(config.settings?.startupMetadataCheck, false);
    assert.equal(
      "metadataBootstrap" in (config.settings ?? {}),
      false,
      "运行期对象里不允许残留旧字段",
    );

    const notes = takeConfigMigrationNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /metadataBootstrap/);
    assert.match(notes[0], /startupMetadataCheck/);
    assert.match(notes[0], /off → false/);
  });

  it('旧值 "background" 归一化为 startupMetadataCheck=true', () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ metadataBootstrap: "background" }));

    const config = loadConfig();

    assert.equal(config.settings?.startupMetadataCheck, true);
    assert.equal("metadataBootstrap" in (config.settings ?? {}), false);
    assert.match(takeConfigMigrationNotes()[0], /background → true/);
  });

  it("新旧字段同时存在时以新字段为准，并提示删除旧字段", () => {
    const dir = freshHome();
    writeRawConfig(
      dir,
      baseConfig({ metadataBootstrap: "off", startupMetadataCheck: true }),
    );

    const config = loadConfig();

    assert.equal(
      config.settings?.startupMetadataCheck,
      true,
      "新字段优先，不允许被旧字段覆盖",
    );
    assert.equal("metadataBootstrap" in (config.settings ?? {}), false);

    const notes = takeConfigMigrationNotes();
    assert.equal(notes.length, 1);
    assert.match(notes[0], /同时存在/);
    assert.match(notes[0], /请删除/);
  });

  it("只配置新字段时不产生任何迁移提示", () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ startupMetadataCheck: false }));

    const config = loadConfig();

    assert.equal(config.settings?.startupMetadataCheck, false);
    assert.deepEqual(takeConfigMigrationNotes(), []);
  });

  it("两个字段都不配置时保持 undefined，由读取方兜底默认值", () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ debug: true }));

    const config = loadConfig();

    assert.equal(config.settings?.startupMetadataCheck, undefined);
    assert.deepEqual(takeConfigMigrationNotes(), []);
  });

  it("旧字段的非法取值仍然会被 schema 拦下，不会被静默忽略", () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ metadataBootstrap: "yes" }));

    assert.throws(() => loadConfig(), /metadataBootstrap/);
  });
});

describe("配置迁移 - 落盘只产出新字段", () => {
  it("loadConfig → saveConfig 之后，config.json 里只有 startupMetadataCheck", () => {
    const dir = freshHome();
    writeRawConfig(dir, baseConfig({ metadataBootstrap: "off", debug: true }));

    const config = loadConfig();
    saveConfig(config);

    const raw = fs.readFileSync(path.join(dir, "config.json"), "utf-8");
    const persisted = JSON.parse(raw) as {
      settings: Record<string, unknown>;
    };

    assert.equal(
      raw.includes("metadataBootstrap"),
      false,
      "落盘内容里不允许出现旧字段名",
    );
    assert.equal(persisted.settings.startupMetadataCheck, false);
    assert.equal(persisted.settings.debug, true, "其余配置项必须原样保留");
  });

  it("新建配置文件的模板使用新字段名", () => {
    const dir = freshHome();
    // 不预写 config.json，让 ensureConfigFile 生成默认模板
    const config = loadConfig();

    assert.equal(config.settings?.startupMetadataCheck, true);

    const raw = fs.readFileSync(path.join(dir, "config.json"), "utf-8");
    assert.equal(raw.includes("metadataBootstrap"), false);
    assert.match(raw, /"startupMetadataCheck": true/);
  });
});
