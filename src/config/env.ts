import "dotenv/config";
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const rankingDisplayLimit = z.coerce.number().int().min(1).max(25);
const booleanFlag = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

const schema = z.object({
  DATA_MODE: z.enum(["mysql", "memory"]).default("mysql"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  INVITE_CHANNEL_ID: z.string().min(1),
  PANEL_CHANNEL_ID: z.string().min(1),
  RANKING_CHANNEL_ID: z.string().min(1),
  WELCOME_CHANNEL_ID: z.string().min(1),
  ADMIN_LOG_CHANNEL_ID: z.string().min(1),
  LINKED_ROLE_ID: z.string().min(1),
  PANEL_THUMBNAIL_URL: z.string().url().optional().or(z.literal("")),
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: positiveInt.default(3306),
  MYSQL_USER: z.string().default(""),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_DATABASE: z.string().default("blacklist_referralbot"),
  ROLE_SYNC_INTERVAL_MS: positiveInt.default(600_000),
  INVITE_RECHECK_INTERVAL_MS: positiveInt.default(600_000),
  LOG_DISPATCH_INTERVAL_MS: positiveInt.default(30_000),
  CLEANUP_INTERVAL_MS: positiveInt.default(86_400_000),
  HISTORY_RETENTION_DAYS: positiveInt.default(365),
  INVITE_CREATION_COOLDOWN_MS: positiveInt.default(60_000),
  REFERRALS_VIEW_COOLDOWN_MS: positiveInt.default(5_000),
  RANKING_DISPLAY_LIMIT: rankingDisplayLimit.default(10),
  WELCOME_MESSAGE_ENABLED: booleanFlag.default(true),
  ADMIN_COMMAND_COOLDOWN_MS: positiveInt.default(5_000),
  PAGINATION_TIMEOUT_MS: positiveInt.default(120_000),
  CROSSCHAT_DATABASE: z.string().default(""),
  CROSSCHAT_TABLE: z.string().default(""),
  PLAYER_LINK_TABLE: z.string().default(""),
  PLAYER_LINK_DISCORD_ID_COLUMN: z.string().default("discord_id"),
  PLAYER_LINK_EOS_ID_COLUMN: z.string().default("eos_id"),
  PLAYTIME_DATABASE: z.string().default(""),
  PLAYTIME_TABLE: z.string().default("lethalquestsascended_stats"),
  PLAYTIME_EOS_ID_COLUMN: z.string().default("EOSID"),
  PLAYTIME_MINUTES_COLUMN: z.string().default("MinutesPlayed")
});

export const env = schema.parse(process.env);
export const BOT_VERSION = "0.1.0";
