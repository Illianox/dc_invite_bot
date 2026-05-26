import type { Pool, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import type { OnlinePlayersConfig } from "../config/referralRewards.js";

export interface OnlinePlayerLocation {
  mapName: string;
  serverId: string;
}

export interface PlayerStatsReader {
  findEosId(discordId: string): Promise<string | null>;
  getMinutesPlayed(eosId: string): Promise<number | null>;
  findOnlineLocation(eosId: string, config: OnlinePlayersConfig): Promise<OnlinePlayerLocation | null>;
}

export class MySqlPlayerStatsRepository implements PlayerStatsReader {
  private readonly linkTable = sqlTableIdentifier(env.CROSSCHAT_DATABASE, env.CROSSCHAT_TABLE || env.PLAYER_LINK_TABLE);
  private readonly linkDiscordColumn = sqlIdentifier(env.PLAYER_LINK_DISCORD_ID_COLUMN);
  private readonly linkEosColumn = sqlIdentifier(env.PLAYER_LINK_EOS_ID_COLUMN);
  private readonly playtimeTable = sqlTableIdentifier(env.PLAYTIME_DATABASE, env.PLAYTIME_TABLE);
  private readonly playtimeEosColumn = sqlIdentifier(env.PLAYTIME_EOS_ID_COLUMN);
  private readonly playtimeMinutesColumn = sqlIdentifier(env.PLAYTIME_MINUTES_COLUMN);

  public constructor(private readonly pool: Pool) {}

  public async findEosId(discordId: string): Promise<string | null> {
    if (!this.linkTable) return null;
    const [rows] = await this.pool.query<Array<RowDataPacket & { eos_id: string }>>(
      `SELECT ${this.linkEosColumn} AS eos_id FROM ${this.linkTable} WHERE ${this.linkDiscordColumn} = ? LIMIT 1`,
      [discordId]
    );
    return rows[0]?.eos_id ?? null;
  }

  public async getMinutesPlayed(eosId: string): Promise<number | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { minutes_played: number }>>(
      `SELECT ${this.playtimeMinutesColumn} AS minutes_played FROM ${this.playtimeTable} WHERE ${this.playtimeEosColumn} = ? LIMIT 1`,
      [eosId]
    );
    const value = rows[0]?.minutes_played;
    return Number.isFinite(value) ? Number(value) : null;
  }

  public async findOnlineLocation(eosId: string, config: OnlinePlayersConfig): Promise<OnlinePlayerLocation | null> {
    const table = sqlTableIdentifier(config.database, config.table);
    const eosColumn = sqlIdentifier(config.eosIdColumn);
    const serverIdColumn = sqlIdentifier(config.serverIdColumn);
    const mapNameColumn = sqlIdentifier(config.mapNameColumn);
    const [rows] = await this.pool.query<Array<RowDataPacket & { server_id: string | number; map_name: string }>>(
      `SELECT ${serverIdColumn} AS server_id, ${mapNameColumn} AS map_name FROM ${table} WHERE ${eosColumn} = ? LIMIT 1`,
      [eosId]
    );
    const row = rows[0];
    return row ? { serverId: String(row.server_id), mapName: row.map_name } : null;
  }
}

export class MemoryPlayerStatsRepository implements PlayerStatsReader {
  private readonly links = new Map<string, string>();
  private readonly minutes = new Map<string, number>();
  private readonly locations = new Map<string, OnlinePlayerLocation>();

  public setLink(discordId: string, eosId: string): void {
    this.links.set(discordId, eosId);
  }

  public setMinutes(eosId: string, minutes: number): void {
    this.minutes.set(eosId, minutes);
  }

  public setOnlineLocation(eosId: string, location: OnlinePlayerLocation | null): void {
    if (location) this.locations.set(eosId, location);
    else this.locations.delete(eosId);
  }

  public async findEosId(discordId: string): Promise<string | null> {
    return this.links.get(discordId) ?? null;
  }

  public async getMinutesPlayed(eosId: string): Promise<number | null> {
    return this.minutes.get(eosId) ?? null;
  }

  public async findOnlineLocation(eosId: string, _config: OnlinePlayersConfig): Promise<OnlinePlayerLocation | null> {
    return this.locations.get(eosId) ?? null;
  }
}

function sqlTableIdentifier(database: string, table: string): string {
  if (!table) return "";
  if (!database) return sqlIdentifier(table);
  return `${sqlIdentifier(database)}.${sqlIdentifier(table)}`;
}

function sqlIdentifier(value: string): string {
  if (!value) return "";
  const parts = value.split(".");
  if (!parts.every((part) => /^[A-Za-z0-9_]+$/.test(part))) {
    throw new Error(`Unsafe SQL identifier configured: ${value}`);
  }
  return parts.map((part) => `\`${part}\``).join(".");
}
