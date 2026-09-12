// import-command.ts - `mcp-adapter import` CLI 子命令
//
// 把现有 AI 客户端（Claude Code / OpenCode 等）的 MCP 配置导入 adapter 的工作区。
// 与网关主链路零耦合，index.ts 只做入口分发。

import {
  applyImportPlan,
  createImportPlan,
  detectClientConfigs,
  formatDetectedClientConfigs,
  formatKnownClientPaths,
  getDefaultConfigForClient,
  inferClientFromDefaultPath,
  printImportDryRun,
} from "../client-config/import-service.js";
import { writeLog } from "../logger.js";

function readCliOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    writeLog(`[Error] ${flag} 必须跟随一个参数值。\n`);
    process.exit(1);
  }
  return value;
}

export function runImportCommand(args: string[]): void {
  const fromArg = readCliOption(args, "--from");
  let fromPath = fromArg;
  let clientName = readCliOption(args, "--client");
  const dryRun = args.includes("--dry-run");
  const writeClientConfig = args.includes("--write-client-config");

  try {
    if (fromPath && !clientName) {
      const inferred = inferClientFromDefaultPath(fromPath);
      if (!inferred) {
        throw new Error(
          "使用非默认路径 --from 时必须同时指定 --client <name>，用于确定导入格式和目标配置。",
        );
      }
      clientName = inferred.client.name;
    }

    if (!fromPath && clientName) {
      fromPath = getDefaultConfigForClient(clientName);
      if (!fromPath) {
        throw new Error(
          `未找到 client=${clientName} 的默认配置文件，或该配置文件不包含受支持的 MCP 配置。请使用 --from <path> 指定源配置。`,
        );
      }
    }

    if (!fromPath || !clientName) {
      const detected = detectClientConfigs();
      if (detected.length === 1) {
        const [source] = detected;
        if (!dryRun) {
          throw new Error(
            `自动检测到 ${source.client.displayName} 配置: ${source.path}\n` +
              "请先运行 --dry-run 确认，或显式指定 --client 与 --from 后再正式导入。\n" +
              `示例: mcp-adapter import --client ${source.client.name} --from ${source.path}`,
          );
        }
        clientName = source.client.name;
        fromPath = source.path;
      } else if (detected.length > 1) {
        throw new Error(
          "检测到多个 AI 客户端配置文件，请使用 --client 和 --from 明确指定：\n" +
            formatDetectedClientConfigs(detected),
        );
      } else {
        throw new Error(
          "未找到源配置文件。请使用 --client <name> --from <path> 指定客户端和配置路径。\n" +
            "已知默认路径：\n" +
            formatKnownClientPaths(),
        );
      }
    }

    const plan = createImportPlan({ clientName, fromPath });

    if (dryRun) {
      printImportDryRun(plan);
      process.exit(0);
    }

    applyImportPlan(plan, { writeClientConfig });
    writeLog(
      `\n[Import] 成功导入 ${plan.importedServers.length} 个 MCP 服务至 ${plan.adapterConfigPath}。\n` +
        (writeClientConfig
          ? `[Import] 已回写 ${plan.client.displayName} 配置: ${plan.sourcePath}\n`
          : "[Import] 未回写 client 配置。如需替换原配置，请重新运行并添加 --write-client-config。\n"),
    );
  } catch (err) {
    writeLog(
      `[Import-Error] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
