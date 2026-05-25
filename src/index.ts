import { Client, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { checkDatabase, pool } from "./database/pool.js";
import { BotRepository } from "./database/repositories/botRepository.js";
import { MemoryRepository } from "./database/repositories/memoryRepository.js";
import type { Repository } from "./database/repositories/repository.js";
import { registerEvents } from "./events/registerEvents.js";
import { CooldownService } from "./services/cooldownService.js";
import { InviteService } from "./services/inviteService.js";
import { LogDispatcher } from "./services/logDispatcher.js";
import { MemoryPlayerStatsRepository, MySqlPlayerStatsRepository } from "./services/playerStatsRepository.js";
import { RconRewardClient } from "./services/rconClient.js";
import { ReferralRewardService } from "./services/referralRewardService.js";
import { ReferralService } from "./services/referralService.js";
import { validateDiscordSetup } from "./services/startupValidation.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});
const repository: Repository = env.DATA_MODE === "memory" ? new MemoryRepository() : new BotRepository(pool);
const invites = new InviteService(repository);
const referrals = new ReferralService(repository);
const playerStats = env.DATA_MODE === "memory" ? new MemoryPlayerStatsRepository() : new MySqlPlayerStatsRepository(pool);
const rewards = new ReferralRewardService(repository, playerStats, new RconRewardClient());
const cooldowns = new CooldownService();
const logs = new LogDispatcher(client, repository);
const startedAt = Date.now();
const timers: NodeJS.Timeout[] = [];
const checkStorage = env.DATA_MODE === "memory"
  ? async (): Promise<number> => 0
  : checkDatabase;

registerEvents(client, { client, repository, invites, referrals, playerStats, rewards, cooldowns, startedAt, storageMode: env.DATA_MODE, checkStorage });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
    await validateDiscordSetup(guild);
    await repository.recoverOpenJoins(guild.id);
    await invites.establishBaseline(guild);
    const rewardConfig = await rewards.reloadConfig();
    await logs.dispatch();

    timers.push(setInterval(() => void referrals.syncRunning(guild).catch((error) => repository.logError("role_sync_error", String(error))), env.ROLE_SYNC_INTERVAL_MS));
    if (rewardConfig.enabled) {
      timers.push(setInterval(() => void rewards.checkAll(guild.id).catch((error) => repository.logError("referral_reward_check_error", String(error))), rewardConfig.checkIntervalSeconds * 1000));
    }
    timers.push(setInterval(() => void invites.establishBaseline(guild, "recovery").catch((error) => repository.logError("invite_sync_error", String(error))), env.INVITE_RECHECK_INTERVAL_MS));
    timers.push(setInterval(() => void logs.dispatch().catch((error) => repository.logError("log_dispatch_error", String(error))), env.LOG_DISPATCH_INTERVAL_MS));
    timers.push(setInterval(() => void repository.deleteExpiredHistory(env.HISTORY_RETENTION_DAYS).catch((error) => repository.logError("cleanup_error", String(error))), env.CLEANUP_INTERVAL_MS));
    console.log(`Blacklist Spieler werben Spieler System v0.1.0 ready as ${client.user?.tag} using ${env.DATA_MODE} storage.`);
  } catch (error) {
    console.error("Startup validation failed.", error);
    await repository.logError("startup_error", String(error)).catch(() => undefined);
    client.destroy();
    if (env.DATA_MODE === "mysql") await pool.end();
    process.exitCode = 1;
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  for (const timer of timers) clearInterval(timer);
  const guild = client.guilds.cache.get(env.DISCORD_GUILD_ID);
  if (guild) await invites.establishBaseline(guild, "recovery").catch(() => undefined);
  await logs.dispatch().catch(() => undefined);
  client.destroy();
  if (env.DATA_MODE === "mysql") await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void client.login(env.DISCORD_TOKEN).catch(async (error) => {
  console.error("Discord login failed.", error);
  if (env.DATA_MODE === "mysql") await pool.end();
  process.exitCode = 1;
});
