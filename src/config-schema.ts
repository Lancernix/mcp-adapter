// config-schema.ts - Zod schema for config.json validation
import { z } from "zod";

export const ServerConfigSchema = z
  .object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    aliases: z.array(z.string()).optional(),
    lifecycle: z.enum(["lazy", "eager", "keep-alive"]).optional(),
    idleTimeout: z.number().positive().optional(),
    disabled: z.boolean().optional(),
    refreshOnStartup: z.boolean().optional(),
    connectTimeoutMs: z.number().int().nonnegative().optional(),
    requestTimeoutMs: z.number().int().nonnegative().optional(),
    closeTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .superRefine((cfg, ctx) => {
    if (cfg.disabled) return;

    const type = cfg.type ?? "stdio";

    if (type === "stdio" && !cfg.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio 类型 server 必须配置 command",
      });
    }

    if ((type === "http" || type === "sse") && !cfg.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `${type} 类型 server 必须配置 url`,
      });
    }

    if (cfg.url) {
      try {
        new URL(cfg.url);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "url 不是合法 URL",
        });
      }
    }
  });

const SettingsSchema = z
  .object({
    idleTimeout: z.number().positive().optional(),
    cacheTtlDays: z.number().nonnegative().optional(),
    toolSearchLimit: z.number().int().min(1).max(20).optional(),
    metadataBootstrap: z.enum(["background", "off"]).optional(),
    debug: z.boolean().optional(),
    connectTimeoutMs: z.number().int().nonnegative().optional(),
    requestTimeoutMs: z.number().int().nonnegative().optional(),
    closeTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const AdapterConfigSchema = z
  .object({
    version: z.number().int().positive(),
    settings: SettingsSchema.optional(),
    mcpServers: z.record(z.string(), ServerConfigSchema),
  })
  .passthrough();
