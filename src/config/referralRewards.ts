import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const rconServerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  password: z.string()
});

const configSchema = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  checkIntervalSeconds: z.number().int().positive().default(300),
  maxRetryAttempts: z.number().int().positive().default(5),
  retryDelaySeconds: z.number().int().positive().default(300),
  multiServerRewards: z.boolean().default(false),
  rewardServer: rconServerSchema,
  clusterServers: z.array(rconServerSchema).default([])
}).superRefine((config, ctx) => {
  if (config.multiServerRewards && config.clusterServers.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clusterServers must not be empty when multiServerRewards is true." });
  }
});

export type ReferralRewardsConfig = z.infer<typeof configSchema>;
export type RconServerConfig = ReferralRewardsConfig["rewardServer"];

const configPath = resolve(process.cwd(), "referralRewards.json");

export async function loadReferralRewardsConfig(): Promise<ReferralRewardsConfig> {
  const raw = await readFile(configPath, "utf8");
  return configSchema.parse(JSON.parse(raw));
}
