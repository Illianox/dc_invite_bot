import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { InviteStatus, Referral, ReferralRewardLog, ReferralRewardStep, ReferralStatus, ReferralStepProgress, ReferralStepStatus, RewardReferralStatus, UserInvite } from "../../utils/domain.js";
import type { PanelMessageType, PendingLog, Repository } from "./repository.js";

interface UserInviteRow extends RowDataPacket {
  id: number;
  guild_id: string;
  inviter_discord_id: string;
  invite_code: string;
  channel_id: string;
  status: InviteStatus;
  created_at: Date;
}

interface ReferralRow extends RowDataPacket {
  id: number;
  guild_id: string;
  inviter_discord_id: string | null;
  inviter_discord_name: string | null;
  invitee_discord_id: string;
  invitee_discord_name: string | null;
  invite_code: string | null;
  joined_at: Date;
  status: ReferralStatus;
  qualified_at: Date | null;
  left_at: Date | null;
  inviter_eos_id: string | null;
  invited_eos_id: string | null;
  start_minutes: number | null;
  reward_status: RewardReferralStatus;
  blocked_reason: string | null;
  rewarded_completed_at: Date | null;
}

interface ReferralStepProgressRow extends RowDataPacket {
  id: number;
  referral_id: number;
  step_key: string;
  required_minutes: number;
  status: ReferralStepStatus;
  attempt_count: number;
  next_retry_at: Date | null;
  last_error: string | null;
  paid_at: Date | null;
  created_at: Date;
}

interface RewardStepRow extends RowDataPacket {
  step_key: string;
  required_minutes: number;
  inviter_commands: string | string[];
  invited_commands: string | string[];
  enabled: 0 | 1 | boolean;
}

interface RuntimeLog extends PendingLog {
  discordDeliveryStatus: "pending" | "sent" | "failed";
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

function mapInvite(row: UserInviteRow): UserInvite {
  return {
    id: row.id,
    guildId: row.guild_id,
    inviterDiscordId: row.inviter_discord_id,
    inviteCode: row.invite_code,
    channelId: row.channel_id,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapReferral(row: ReferralRow): Referral {
  return {
    id: row.id,
    guildId: row.guild_id,
    inviterDiscordId: row.inviter_discord_id,
    inviterDiscordName: row.inviter_discord_name,
    inviteeDiscordId: row.invitee_discord_id,
    inviteeDiscordName: row.invitee_discord_name,
    inviteCode: row.invite_code,
    joinedAt: row.joined_at,
    status: row.status,
    qualifiedAt: row.qualified_at,
    leftAt: row.left_at,
    inviterEosId: row.inviter_eos_id,
    invitedEosId: row.invited_eos_id,
    startMinutes: row.start_minutes,
    rewardStatus: row.reward_status,
    blockedReason: row.blocked_reason,
    rewardedCompletedAt: row.rewarded_completed_at
  };
}

function mapStepProgress(row: ReferralStepProgressRow): ReferralStepProgress {
  return {
    id: row.id,
    referralId: row.referral_id,
    stepKey: row.step_key,
    requiredMinutes: row.required_minutes,
    status: row.status,
    attemptCount: row.attempt_count,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    paidAt: row.paid_at,
    createdAt: row.created_at
  };
}

export class BotRepository implements Repository {
  private logId = 1;
  private latestErrorSummary: string | null = null;
  private readonly logs: RuntimeLog[] = [];

  public constructor(private readonly pool: Pool) {}

  public async findActiveInvite(guildId: string, inviterId: string): Promise<UserInvite | null> {
    const [rows] = await this.pool.query<UserInviteRow[]>(
      "SELECT * FROM user_invites WHERE guild_id = ? AND inviter_discord_id = ? AND status = 'active' LIMIT 1",
      [guildId, inviterId]
    );
    return rows[0] ? mapInvite(rows[0]) : null;
  }

  public async listActiveInvites(guildId: string): Promise<UserInvite[]> {
    const [rows] = await this.pool.query<UserInviteRow[]>(
      "SELECT * FROM user_invites WHERE guild_id = ? AND status = 'active'",
      [guildId]
    );
    return rows.map(mapInvite);
  }

  public async createInvite(
    guildId: string,
    inviterId: string,
    inviteCode: string,
    channelId: string,
    knownUses: number
  ): Promise<void> {
    await this.inTransaction(async (connection) => {
      await connection.query(
        "INSERT INTO user_invites (guild_id, inviter_discord_id, invite_code, channel_id) VALUES (?, ?, ?, ?)",
        [guildId, inviterId, inviteCode, channelId]
      );
      await this.upsertSnapshot(connection, inviteCode, knownUses, "invite_created");
      await this.insertLog(connection, "info", "invite_created", inviterId, null, `Einladungslink ${this.shortCode(inviteCode)} wurde von ${this.mention(inviterId)} erstellt.`);
    });
  }

  public async markInviteDeleted(invite: UserInvite): Promise<void> {
    await this.inTransaction(async (connection) => {
      await connection.query(
        "UPDATE user_invites SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
        [invite.id]
      );
      await this.insertLog(connection, "warn", "invite_deleted", invite.inviterDiscordId, null, `Einladungslink ${this.shortCode(invite.inviteCode)} von ${this.mention(invite.inviterDiscordId)} existiert nicht mehr.`);
    });
  }

  public async loadSnapshotMap(): Promise<Map<string, number>> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { invite_code: string; known_uses: number }>>(
      "SELECT invite_code, known_uses FROM invite_snapshots"
    );
    return new Map(rows.map((row) => [row.invite_code, row.known_uses]));
  }

  public async saveSnapshots(
    uses: Map<string, number>,
    reason: "startup" | "join_processed" | "invite_created" | "recovery"
  ): Promise<void> {
    await this.inTransaction(async (connection) => {
      for (const [code, count] of uses) {
        await this.upsertSnapshot(connection, code, count, reason);
      }
    });
  }

  public async enqueueJoin(guildId: string, inviteeId: string, inviteeName: string | null, joinedAt: Date): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      "INSERT INTO join_processing_queue (guild_id, invitee_discord_id, invitee_discord_name, joined_at) VALUES (?, ?, ?, ?)",
      [guildId, inviteeId, inviteeName, joinedAt]
    );
    return result.insertId;
  }

  public async recoverOpenJoins(guildId: string): Promise<number> {
    return this.inTransaction(async (connection) => {
      const [rows] = await connection.query<Array<RowDataPacket & { id: number; invitee_discord_id: string; invitee_discord_name: string | null; joined_at: Date }>>(
        "SELECT id, invitee_discord_id, invitee_discord_name, joined_at FROM join_processing_queue WHERE guild_id = ? AND status IN ('queued', 'processing') FOR UPDATE",
        [guildId]
      );
      for (const row of rows) {
        const [result] = await connection.query<ResultSetHeader>(
          `INSERT INTO referrals (guild_id, invitee_discord_id, invitee_discord_name, joined_at, status)
           VALUES (?, ?, ?, ?, 'unresolved')`,
          [guildId, row.invitee_discord_id, row.invitee_discord_name, row.joined_at]
        );
        await connection.query(
          `INSERT INTO referral_events (referral_id, event_type, new_status, reason)
           VALUES (?, 'startup_recovery', 'unresolved', 'Offener Beitritt wurde nach einem Neustart wiederhergestellt.')`,
          [result.insertId]
        );
        await connection.query("UPDATE join_processing_queue SET status = 'failed', last_error = 'Nach Neustart wiederhergestellt.' WHERE id = ?", [row.id]);
        await this.insertLog(connection, "warn", "join_startup_recovery", row.invitee_discord_id, result.insertId, `Offener Beitritt von ${this.mention(row.invitee_discord_id)} wurde nach einem Neustart als ungeklaert markiert.`);
      }
      return rows.length;
    });
  }

  public async setQueueAttempt(id: number, attempt: number, nextAttemptAt: Date | null, error: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE join_processing_queue SET status = 'processing', attempt_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
      [attempt, nextAttemptAt, error, id]
    );
  }

  public async resolveQueuedJoin(
    queueId: number,
    data: {
      guildId: string;
      inviterId: string | null;
      inviterName: string | null;
      inviteeId: string;
      inviteeName: string | null;
      inviteCode: string | null;
      joinedAt: Date;
      status: ReferralStatus;
      reason: string;
    },
    snapshots: Map<string, number>
  ): Promise<number> {
    return this.inTransaction(async (connection) => {
      const [result] = await connection.query<ResultSetHeader>(
        `INSERT INTO referrals
          (guild_id, inviter_discord_id, inviter_discord_name, invitee_discord_id, invitee_discord_name, invite_code, joined_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.guildId, data.inviterId, data.inviterName, data.inviteeId, data.inviteeName, data.inviteCode, data.joinedAt, data.status]
      );
      const referralId = result.insertId;
      await connection.query(
        "INSERT INTO referral_events (referral_id, event_type, new_status, reason) VALUES (?, 'join_resolved', ?, ?)",
        [referralId, data.status, data.reason]
      );
      for (const [code, count] of snapshots) {
        await this.upsertSnapshot(connection, code, count, "join_processed");
      }
      await connection.query("UPDATE join_processing_queue SET status = 'resolved' WHERE id = ?", [queueId]);
      await this.insertLog(connection, data.status === "unresolved" ? "warn" : "info", `referral_${data.status}`, data.inviteeId, referralId, this.referralLogDetails(data.inviteeId, data.inviterId, data.status, data.reason));
      return referralId;
    });
  }

  public async findCurrentReferral(guildId: string, inviteeId: string): Promise<Referral | null> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      `SELECT * FROM referrals
       WHERE guild_id = ? AND invitee_discord_id = ? AND status IN ('pending', 'qualified', 'unqualified')
       ORDER BY id DESC LIMIT 1`,
      [guildId, inviteeId]
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  public async findLatestAssignableReferral(guildId: string, inviteeId: string): Promise<Referral | null> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      `SELECT * FROM referrals
       WHERE guild_id = ? AND invitee_discord_id = ? AND status IN ('unresolved', 'non_referral')
       ORDER BY id DESC LIMIT 1`,
      [guildId, inviteeId]
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  public async transitionReferral(
    referral: Referral,
    nextStatus: ReferralStatus,
    eventType: string,
    actorId: string | null,
    reason: string
  ): Promise<void> {
    await this.inTransaction(async (connection) => {
      const [update] = await connection.query<ResultSetHeader>(
        `UPDATE referrals SET status = ?,
          qualified_at = CASE WHEN ? = 'qualified' THEN COALESCE(qualified_at, CURRENT_TIMESTAMP) ELSE qualified_at END,
          left_at = CASE WHEN ? = 'left' THEN CURRENT_TIMESTAMP ELSE left_at END,
          resolved_by_admin_id = COALESCE(?, resolved_by_admin_id),
          resolution_reason = CASE WHEN ? IS NOT NULL THEN ? ELSE resolution_reason END
         WHERE id = ? AND status = ?`,
        [nextStatus, nextStatus, nextStatus, actorId, actorId, reason, referral.id, referral.status]
      );
      if (update.affectedRows !== 1) throw new Error("Spielerwerbung wurde geaendert, bevor der angeforderte Statuswechsel angewendet werden konnte.");
      await connection.query(
        `INSERT INTO referral_events
          (referral_id, event_type, old_status, new_status, actor_discord_id, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [referral.id, eventType, referral.status, nextStatus, actorId, reason]
      );
      await this.insertLog(connection, "info", eventType, referral.inviteeDiscordId, referral.id, this.referralLogDetails(referral.inviteeDiscordId, referral.inviterDiscordId, nextStatus, reason));
    });
  }

  public async assignReferral(referral: Referral, inviterId: string, inviterName: string | null, inviteeName: string | null, nextStatus: "pending" | "qualified", adminId: string, reason: string): Promise<void> {
    await this.inTransaction(async (connection) => {
      const [update] = await connection.query<ResultSetHeader>(
        `UPDATE referrals SET inviter_discord_id = ?, inviter_discord_name = ?, invitee_discord_name = COALESCE(?, invitee_discord_name),
         status = ?, resolved_by_admin_id = ?, resolution_reason = ?,
         qualified_at = CASE WHEN ? = 'qualified' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = ? AND status IN ('unresolved', 'non_referral')`,
        [inviterId, inviterName, inviteeName, nextStatus, adminId, reason, nextStatus, referral.id]
      );
      if (update.affectedRows !== 1) throw new Error("Spielerwerbung kann nicht mehr zugeordnet werden.");
      await connection.query(
        `INSERT INTO referral_events
          (referral_id, event_type, old_status, new_status, actor_discord_id, reason)
         VALUES (?, 'admin_assign', ?, ?, ?, ?)`,
        [referral.id, referral.status, nextStatus, adminId, reason]
      );
      await this.insertLog(connection, "info", "admin_assign", referral.inviteeDiscordId, referral.id, this.referralLogDetails(referral.inviteeDiscordId, inviterId, nextStatus, reason));
    });
  }

  public async listQualifiedByInviter(guildId: string, inviterId: string): Promise<Referral[]> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      "SELECT * FROM referrals WHERE guild_id = ? AND inviter_discord_id = ? AND status = 'qualified' ORDER BY joined_at DESC",
      [guildId, inviterId]
    );
    return rows.map(mapReferral);
  }

  public async getRanking(guildId: string, period: { start: Date; end: Date } | null, limit: number): Promise<Array<{ inviterId: string; total: number }>> {
    const periodFilter = period ? "AND qualified_at >= ? AND qualified_at < ?" : "";
    const params = period ? [guildId, period.start, period.end, limit] : [guildId, limit];
    const [rows] = await this.pool.query<Array<RowDataPacket & { inviter_discord_id: string; total: number }>>(
      `SELECT inviter_discord_id, COUNT(*) AS total FROM referrals
       WHERE guild_id = ? AND status = 'qualified' AND inviter_discord_id IS NOT NULL
         ${periodFilter}
       GROUP BY inviter_discord_id ORDER BY total DESC LIMIT ?`,
      params
    );
    return rows.map((row) => ({ inviterId: row.inviter_discord_id, total: row.total }));
  }

  public async listReferralHistory(guildId: string, inviteeId: string): Promise<Referral[]> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      "SELECT * FROM referrals WHERE guild_id = ? AND invitee_discord_id = ? ORDER BY created_at DESC LIMIT 25",
      [guildId, inviteeId]
    );
    return rows.map(mapReferral);
  }

  public async listRunningReferrals(guildId: string): Promise<Referral[]> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      "SELECT * FROM referrals WHERE guild_id = ? AND status IN ('pending', 'qualified', 'unqualified')",
      [guildId]
    );
    return rows.map(mapReferral);
  }

  public async listRewardReferrals(guildId: string): Promise<Referral[]> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      `SELECT * FROM referrals
       WHERE guild_id = ? AND status = 'qualified' AND inviter_discord_id IS NOT NULL
         AND reward_status IN ('pending', 'active')
       ORDER BY id ASC`,
      [guildId]
    );
    return rows.map(mapReferral);
  }

  public async listRewardSteps(): Promise<ReferralRewardStep[]> {
    const [rows] = await this.pool.query<RewardStepRow[]>(
      `SELECT step_key, required_minutes, inviter_commands, invited_commands, enabled
       FROM referral_reward_steps
       WHERE enabled = TRUE
       ORDER BY required_minutes ASC, step_key ASC`
    );
    return rows.map((row) => ({
      key: row.step_key,
      requiredMinutes: row.required_minutes,
      inviterCommands: parseCommandList(row.inviter_commands),
      invitedCommands: parseCommandList(row.invited_commands),
      enabled: row.enabled === true || row.enabled === 1
    }));
  }

  public async findRewardReferralByInvitee(guildId: string, inviteeId: string): Promise<Referral | null> {
    const [rows] = await this.pool.query<ReferralRow[]>(
      "SELECT * FROM referrals WHERE guild_id = ? AND invitee_discord_id = ? ORDER BY id DESC LIMIT 1",
      [guildId, inviteeId]
    );
    return rows[0] ? mapReferral(rows[0]) : null;
  }

  public async hasExistingRewardReferral(guildId: string, inviteeId: string, excludeReferralId?: number): Promise<boolean> {
    const params: Array<string | number> = [guildId, inviteeId];
    const exclude = excludeReferralId ? "AND id <> ?" : "";
    if (excludeReferralId) params.push(excludeReferralId);
    const [rows] = await this.pool.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM referrals
       WHERE guild_id = ? AND invitee_discord_id = ?
         AND reward_status IN ('pending', 'active', 'completed')
         ${exclude}`,
      params
    );
    return (rows[0]?.total ?? 0) > 0;
  }

  public async hasExistingRewardReferralForEos(guildId: string, invitedEosId: string, excludeReferralId?: number): Promise<boolean> {
    const params: Array<string | number> = [guildId, invitedEosId];
    const exclude = excludeReferralId ? "AND id <> ?" : "";
    if (excludeReferralId) params.push(excludeReferralId);
    const [rows] = await this.pool.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM referrals
       WHERE guild_id = ? AND invited_eos_id = ?
         AND reward_status IN ('active', 'completed', 'blocked')
         ${exclude}`,
      params
    );
    return (rows[0]?.total ?? 0) > 0;
  }

  public async rememberPlayerIdentity(guildId: string, discordId: string, discordName: string | null, eosId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO referral_player_identities (guild_id, discord_id, discord_name, eos_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE discord_name = COALESCE(VALUES(discord_name), discord_name),
         eos_id = VALUES(eos_id), last_seen_at = CURRENT_TIMESTAMP`,
      [guildId, discordId, discordName, eosId]
    );
  }

  public async findRememberedEosId(guildId: string, discordId: string): Promise<string | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { eos_id: string }>>(
      "SELECT eos_id FROM referral_player_identities WHERE guild_id = ? AND discord_id = ? LIMIT 1",
      [guildId, discordId]
    );
    return rows[0]?.eos_id ?? null;
  }

  public async hasRememberedEosId(guildId: string, eosId: string, excludeDiscordId?: string): Promise<boolean> {
    const params = excludeDiscordId ? [guildId, eosId, excludeDiscordId] : [guildId, eosId];
    const exclude = excludeDiscordId ? "AND discord_id <> ?" : "";
    const [rows] = await this.pool.query<Array<RowDataPacket & { total: number }>>(
      `SELECT COUNT(*) AS total FROM referral_player_identities
       WHERE guild_id = ? AND eos_id = ? ${exclude}`,
      params
    );
    return (rows[0]?.total ?? 0) > 0;
  }

  public async activateRewardReferral(referralId: number, inviterEosId: string, invitedEosId: string, startMinutes: number): Promise<boolean> {
    return this.inTransaction(async (connection) => {
      const [existing] = await connection.query<Array<RowDataPacket & {
        guild_id: string;
        inviter_discord_id: string | null;
        inviter_discord_name: string | null;
        invitee_discord_id: string;
        invitee_discord_name: string | null;
      }>>(
        "SELECT guild_id, inviter_discord_id, inviter_discord_name, invitee_discord_id, invitee_discord_name FROM referrals WHERE id = ? FOR UPDATE",
        [referralId]
      );
      const referral = existing[0];
      if (!referral) return false;
      const [duplicates] = await connection.query<Array<RowDataPacket & { total: number }>>(
        `SELECT COUNT(*) AS total FROM referrals
         WHERE guild_id = ? AND invitee_discord_id = ? AND id <> ?
           AND reward_status IN ('pending', 'active', 'completed')`,
        [referral.guild_id, referral.invitee_discord_id, referralId]
      );
      if ((duplicates[0]?.total ?? 0) > 0) return false;
      const [eosDuplicates] = await connection.query<Array<RowDataPacket & { total: number }>>(
        `SELECT COUNT(*) AS total FROM referrals
         WHERE guild_id = ? AND invited_eos_id = ? AND id <> ?
           AND reward_status IN ('active', 'completed', 'blocked')`,
        [referral.guild_id, invitedEosId, referralId]
      );
      if ((eosDuplicates[0]?.total ?? 0) > 0) return false;
      const [update] = await connection.query<ResultSetHeader>(
        `UPDATE referrals
         SET inviter_eos_id = ?, invited_eos_id = ?, start_minutes = ?, reward_status = 'active', blocked_reason = NULL
         WHERE id = ? AND reward_status = 'pending' AND status = 'qualified'`,
        [inviterEosId, invitedEosId, startMinutes, referralId]
      );
      if (update.affectedRows === 1) {
        await this.insertLog(connection, "info", "referral_reward_active", referral.invitee_discord_id, referralId, [
          "Eingeladener Spieler:",
          this.displayUser(referral.invitee_discord_id, referral.invitee_discord_name),
          "",
          "Eingeladen von:",
          referral.inviter_discord_id ? this.displayUser(referral.inviter_discord_id, referral.inviter_discord_name) : "unbekannt",
          "",
          "Start-Spielzeit:",
          this.formatMinutes(startMinutes),
          "",
          "Status:",
          "Spieler wurde erfolgreich zugeordnet."
        ].join("\n"));
      }
      return update.affectedRows === 1;
    });
  }

  public async updateRewardEos(referralId: number, inviterEosId: string | null, invitedEosId: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE referrals SET inviter_eos_id = COALESCE(?, inviter_eos_id), invited_eos_id = COALESCE(?, invited_eos_id) WHERE id = ?",
      [inviterEosId, invitedEosId, referralId]
    );
  }

  public async blockRewardReferral(referralId: number, reason: string, actorId: string | null): Promise<void> {
    await this.inTransaction(async (connection) => {
      await connection.query("UPDATE referrals SET reward_status = 'blocked', blocked_reason = ? WHERE id = ?", [reason, referralId]);
      await connection.query("UPDATE referral_step_progress SET status = 'blocked' WHERE referral_id = ? AND status <> 'paid'", [referralId]);
      await this.insertLog(connection, "warn", "referral_reward_blocked", actorId, referralId, `Spielerwerbung #${referralId} wurde blockiert.\nGrund: ${reason}`);
    });
  }

  public async unblockRewardReferral(referralId: number, actorId: string | null): Promise<void> {
    await this.inTransaction(async (connection) => {
      await connection.query("UPDATE referrals SET reward_status = CASE WHEN start_minutes IS NULL THEN 'pending' ELSE 'active' END, blocked_reason = NULL WHERE id = ? AND reward_status = 'blocked'", [referralId]);
      await connection.query("UPDATE referral_step_progress SET status = 'pending' WHERE referral_id = ? AND status = 'blocked'", [referralId]);
      await this.insertLog(connection, "info", "referral_reward_unblocked", actorId, referralId, `Spielerwerbung #${referralId} wurde entsperrt.`);
    });
  }

  public async completeRewardReferral(referralId: number): Promise<void> {
    await this.pool.query(
      "UPDATE referrals SET reward_status = 'completed', rewarded_completed_at = CURRENT_TIMESTAMP WHERE id = ? AND reward_status = 'active'",
      [referralId]
    );
  }

  public async ensureStepProgress(referralId: number, stepKey: string, requiredMinutes: number): Promise<ReferralStepProgress> {
    await this.pool.query(
      `INSERT INTO referral_step_progress (referral_id, step_key, required_minutes)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE required_minutes = VALUES(required_minutes)`,
      [referralId, stepKey, requiredMinutes]
    );
    const [rows] = await this.pool.query<ReferralStepProgressRow[]>(
      "SELECT * FROM referral_step_progress WHERE referral_id = ? AND step_key = ? LIMIT 1",
      [referralId, stepKey]
    );
    if (!rows[0]) throw new Error("Step progress could not be loaded after upsert.");
    return mapStepProgress(rows[0]);
  }

  public async listStepProgress(referralId: number): Promise<ReferralStepProgress[]> {
    const [rows] = await this.pool.query<ReferralStepProgressRow[]>(
      "SELECT * FROM referral_step_progress WHERE referral_id = ? ORDER BY required_minutes ASC",
      [referralId]
    );
    return rows.map(mapStepProgress);
  }

  public async markStepPaid(referralId: number, stepKey: string): Promise<void> {
    await this.pool.query(
      "UPDATE referral_step_progress SET status = 'paid', paid_at = CURRENT_TIMESTAMP, last_error = NULL WHERE referral_id = ? AND step_key = ? AND status <> 'paid'",
      [referralId, stepKey]
    );
  }

  public async markStepRetry(referralId: number, stepKey: string, attemptCount: number, nextRetryAt: Date, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE referral_step_progress SET status = 'retry', attempt_count = ?, next_retry_at = ?, last_error = ? WHERE referral_id = ? AND step_key = ? AND status <> 'paid'",
      [attemptCount, nextRetryAt, error.slice(0, 4000), referralId, stepKey]
    );
  }

  public async markStepFailed(referralId: number, stepKey: string, attemptCount: number, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE referral_step_progress SET status = 'failed', attempt_count = ?, next_retry_at = NULL, last_error = ? WHERE referral_id = ? AND step_key = ? AND status <> 'paid'",
      [attemptCount, error.slice(0, 4000), referralId, stepKey]
    );
  }

  public async resetStepForRetry(referralId: number, stepKey: string): Promise<void> {
    await this.pool.query(
      "UPDATE referral_step_progress SET status = 'pending', next_retry_at = NULL, last_error = NULL WHERE referral_id = ? AND step_key = ? AND status <> 'paid'",
      [referralId, stepKey]
    );
  }

  public async logRewardPayout(log: ReferralRewardLog): Promise<void> {
    await this.pool.query(
      `INSERT INTO referral_reward_logs
        (referral_id, step_key, target_type, discord_id, eos_id, command, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [log.referralId, log.stepKey, log.targetType, log.discordId, log.eosId, log.command, log.status, log.errorMessage]
    );
  }

  public async logInfo(eventType: string, discordUserId: string | null, referralId: number | null, details: string): Promise<void> {
    this.addLog("info", eventType, details.slice(0, 4000));
  }

  public async deleteExpiredHistory(retentionDays: number): Promise<void> {
    await this.pool.query(
      `UPDATE referral_events e
       INNER JOIN referrals r ON r.id = e.referral_id
       SET e.actor_discord_id = NULL, e.reason = NULL
       WHERE r.status IN ('left', 'revoked')
       AND r.updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)`,
      [retentionDays]
    );
    await this.pool.query(
      `UPDATE referrals
       SET inviter_discord_id = NULL,
           inviter_discord_name = NULL,
           invitee_discord_id = CONCAT('anon-', id),
           invitee_discord_name = NULL,
           invite_code = NULL,
           resolved_by_admin_id = NULL,
           resolution_reason = NULL
       WHERE status IN ('left', 'revoked')
       AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)`,
      [retentionDays]
    );
  }

  public async logError(eventType: string, details: string): Promise<void> {
    this.addLog("error", eventType, details.slice(0, 4000));
  }

  public async savePanelMessage(panelType: PanelMessageType, guildId: string, channelId: string, messageId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO panel_messages (panel_type, guild_id, channel_id, message_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id)`,
      [panelType, guildId, channelId, messageId]
    );
  }

  public async getPanelMessage(panelType: PanelMessageType, guildId: string): Promise<{ channelId: string; messageId: string } | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { channel_id: string; message_id: string }>>(
      "SELECT channel_id, message_id FROM panel_messages WHERE panel_type = ? AND guild_id = ?",
      [panelType, guildId]
    );
    return rows[0] ? { channelId: rows[0].channel_id, messageId: rows[0].message_id } : null;
  }

  public async pendingLogs(limit = 25): Promise<PendingLog[]> {
    const now = Date.now();
    return this.logs.filter((log) =>
      log.discordDeliveryStatus !== "sent" &&
      (!log.nextAttemptAt || log.nextAttemptAt.getTime() <= now)
    ).slice(0, limit);
  }

  public async markLogSent(id: number): Promise<void> {
    const index = this.logs.findIndex((entry) => entry.id === id);
    if (index >= 0) this.logs.splice(index, 1);
  }

  public async markLogFailed(id: number, attempt: number, retryAt: Date, error: string): Promise<void> {
    const log = this.logs.find((entry) => entry.id === id);
    if (log) {
      log.discordDeliveryStatus = "failed";
      log.discord_attempt_count = attempt;
      log.nextAttemptAt = retryAt;
      log.lastError = error.slice(0, 1000);
    }
  }

  public async latestMigration(): Promise<string | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { version: string }>>(
      "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
    );
    return rows[0]?.version ?? null;
  }

  public async queueLength(): Promise<number> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { total: number }>>(
      "SELECT COUNT(*) AS total FROM join_processing_queue WHERE status IN ('queued', 'processing')"
    );
    return rows[0]?.total ?? 0;
  }

  public async latestSnapshotTime(): Promise<Date | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & { captured_at: Date }>>(
      "SELECT captured_at FROM invite_snapshots ORDER BY captured_at DESC LIMIT 1"
    );
    return rows[0]?.captured_at ?? null;
  }

  public async latestError(): Promise<string | null> {
    return this.latestErrorSummary;
  }

  private async inTransaction<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try {
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private async upsertSnapshot(
    connection: PoolConnection,
    inviteCode: string,
    knownUses: number,
    reason: "startup" | "join_processed" | "invite_created" | "recovery"
  ): Promise<void> {
    await connection.query(
      `INSERT INTO invite_snapshots (invite_code, known_uses, baseline_reason)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE known_uses = VALUES(known_uses), captured_at = CURRENT_TIMESTAMP, baseline_reason = VALUES(baseline_reason)`,
      [inviteCode, knownUses, reason]
    );
  }

  private async insertLog(
    _connection: PoolConnection,
    severity: "info" | "warn" | "error",
    eventType: string,
    _userId: string | null,
    _referralId: number | null,
    details: string
  ): Promise<void> {
    this.addLog(severity, eventType, details.slice(0, 4000));
  }

  private addLog(severity: "info" | "warn" | "error", eventType: string, details: string): void {
    const createdAt = new Date();
    if (severity === "error") this.latestErrorSummary = `${eventType} (${createdAt.toISOString()})`;
    this.logs.push({
      id: this.logId++,
      severity,
      event_type: eventType,
      details,
      discord_attempt_count: 0,
      discordDeliveryStatus: "pending",
      nextAttemptAt: null,
      lastError: null,
      createdAt
    });
  }

  private shortCode(code: string): string {
    return `${code.slice(0, 4)}...`;
  }

  private referralLogDetails(inviteeId: string, inviterId: string | null, status: ReferralStatus, reason: string): string {
    const statusLine = status === "pending"
      ? "Status:\nSpielerwerbung wartet auf Verifizierung."
      : status === "qualified"
        ? "Status:\nSpielerwerbung erfolgreich."
        : `Grund:\n${reason}`;
    return [
      `Eingeladener Spieler:\n${this.mention(inviteeId)}`,
      `Eingeladen von:\n${inviterId ? this.mention(inviterId) : "unbekannt"}`,
      statusLine
    ].join("\n");
  }

  private displayUser(userId: string, userName: string | null): string {
    return userName ? `${userName} (${this.mention(userId)})` : this.mention(userId);
  }

  private formatMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const remaining = minutes % 60;
    return `${hours} Stunden ${remaining} Minuten`;
  }

  private mention(userId: string): string {
    return `<@${userId}>`;
  }
}

function parseCommandList(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Reward command JSON must be an array of strings.");
  }
  return parsed;
}
