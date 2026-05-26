import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const rconServerSchema = z.object({
  name: z.string().min(1),
  serverId: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().positive(),
  password: z.string()
});

const rewardDefinitionSchema = z.object({
  key: z.string().min(1),
  target: z.enum(["inviter", "invited"]),
  mode: z.enum(["global", "online_server"]).default("global"),
  commands: z.array(z.string().min(1)).min(1)
});

const rewardStepSchema = z.object({
  key: z.string().min(1),
  requiredMinutes: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
  rewards: z.array(rewardDefinitionSchema).min(1)
});

const onlinePlayersSchema = z.object({
  database: z.string().min(1).default("blacklistlogin"),
  table: z.string().min(1).default("lethallogin_logged_in_players"),
  eosIdColumn: z.string().min(1).default("eos_id"),
  serverIdColumn: z.string().min(1).default("ServerId"),
  mapNameColumn: z.string().min(1).default("MapName")
});

const configSchema = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(true),
  checkIntervalSeconds: z.number().int().positive().default(300),
  maxRetryAttempts: z.number().int().positive().default(5),
  retryDelaySeconds: z.number().int().positive().default(300),
  multiServerRewards: z.boolean().default(false),
  rewardServer: rconServerSchema,
  clusterServers: z.array(rconServerSchema).default([]),
  onlinePlayers: onlinePlayersSchema.default({}),
  onlineCheckCommand: z.string().min(1).default("ListPlayers"),
  onlineCheckResponseIncludes: z.string().min(1).default("{eos_id}"),
  rewards: z.array(rewardStepSchema).default([])
}).superRefine((config, ctx) => {
  if (config.multiServerRewards && config.clusterServers.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clusterServers must not be empty when multiServerRewards is true." });
  }
  const seen = new Set<string>();
  for (const step of config.rewards) {
    for (const reward of step.rewards) {
      if (seen.has(reward.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Reward key must be unique: ${reward.key}` });
      }
      seen.add(reward.key);
    }
  }
});

export type ReferralRewardsConfig = z.infer<typeof configSchema>;
export type RconServerConfig = ReferralRewardsConfig["rewardServer"];
export type OnlinePlayersConfig = ReferralRewardsConfig["onlinePlayers"];

const configPath = resolve(process.cwd(), "referralRewards.json");

export async function loadReferralRewardsConfig(): Promise<ReferralRewardsConfig> {
  const raw = await readFile(configPath, "utf8");
  return configSchema.parse(JSON.parse(raw));
}
