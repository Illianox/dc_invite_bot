import type { Referral, ReferralRewardLog, ReferralRewardStep, ReferralStatus, ReferralStepProgress, UserInvite } from "../../utils/domain.js";
import type { PanelMessageType, PendingLog, Repository } from "./repository.js";

interface QueueItem {
  id: number;
  guildId: string;
  inviteeId: string;
  inviteeName: string | null;
  joinedAt: Date;
  status: "queued" | "processing" | "resolved" | "failed";
  attemptCount: number;
  error: string | null;
}

interface StoredLog extends PendingLog {
  discordDeliveryStatus: "pending" | "sent" | "failed";
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

interface StoredEvent {
  referralId: number;
  eventType: string;
  oldStatus: ReferralStatus | null;
  newStatus: ReferralStatus;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export class MemoryRepository implements Repository {
  private inviteId = 1;
  private referralId = 1;
  private queueId = 1;
  private logId = 1;
  private stepId = 1;
  private readonly invites: UserInvite[] = [];
  private readonly referrals: Referral[] = [];
  private readonly steps: ReferralStepProgress[] = [];
  private rewardSteps: ReferralRewardStep[] = [];
  private readonly rewardLogs: ReferralRewardLog[] = [];
  private readonly identities = new Map<string, string>();
  private readonly snapshots = new Map<string, { uses: number; capturedAt: Date }>();
  private readonly queue: QueueItem[] = [];
  private readonly logs: StoredLog[] = [];
  private readonly events: StoredEvent[] = [];
  private readonly panels = new Map<string, { channelId: string; messageId: string }>();

  public async findActiveInvite(guildId: string, inviterId: string): Promise<UserInvite | null> {
    return this.invites.find((invite) => invite.guildId === guildId && invite.inviterDiscordId === inviterId && invite.status === "active") ?? null;
  }

  public async listActiveInvites(guildId: string): Promise<UserInvite[]> {
    return this.invites.filter((invite) => invite.guildId === guildId && invite.status === "active");
  }

  public async createInvite(guildId: string, inviterId: string, inviteCode: string, channelId: string, knownUses: number): Promise<void> {
    if (await this.findActiveInvite(guildId, inviterId)) throw new Error("An active personal invite already exists.");
    this.invites.push({
      id: this.inviteId++,
      guildId,
      inviterDiscordId: inviterId,
      inviteCode,
      channelId,
      status: "active",
      createdAt: new Date()
    });
    this.snapshots.set(inviteCode, { uses: knownUses, capturedAt: new Date() });
    this.addLog("info", "invite_created", `Einladungslink ${this.shortCode(inviteCode)} wurde von ${this.mention(inviterId)} erstellt.`);
  }

  public async markInviteDeleted(invite: UserInvite): Promise<void> {
    const stored = this.invites.find((entry) => entry.id === invite.id && entry.status === "active");
    if (stored) stored.status = "deleted";
    this.addLog("warn", "invite_deleted", `Einladungslink ${this.shortCode(invite.inviteCode)} von ${this.mention(invite.inviterDiscordId)} existiert nicht mehr.`);
  }

  public async loadSnapshotMap(): Promise<Map<string, number>> {
    return new Map(Array.from(this.snapshots, ([code, snapshot]) => [code, snapshot.uses]));
  }

  public async saveSnapshots(
    uses: Map<string, number>,
    _reason: "startup" | "join_processed" | "invite_created" | "recovery"
  ): Promise<void> {
    for (const [code, count] of uses) this.snapshots.set(code, { uses: count, capturedAt: new Date() });
  }

  public async enqueueJoin(guildId: string, inviteeId: string, inviteeName: string | null, joinedAt: Date): Promise<number> {
    const id = this.queueId++;
    this.queue.push({ id, guildId, inviteeId, inviteeName, joinedAt, status: "queued", attemptCount: 0, error: null });
    return id;
  }

  public async recoverOpenJoins(guildId: string): Promise<number> {
    const open = this.queue.filter((item) => item.guildId === guildId && (item.status === "queued" || item.status === "processing"));
    for (const item of open) {
      await this.resolveQueuedJoin(item.id, {
        guildId,
        inviterId: null,
        inviterName: null,
        inviteeId: item.inviteeId,
        inviteeName: item.inviteeName,
        inviteCode: null,
        joinedAt: item.joinedAt,
        status: "unresolved",
        reason: "Offener Beitritt wurde nach einem Neustart wiederhergestellt."
      }, new Map());
      item.status = "failed";
    }
    return open.length;
  }

  public async setQueueAttempt(id: number, attempt: number, _nextAttemptAt: Date | null, error: string | null): Promise<void> {
    const item = this.queue.find((entry) => entry.id === id);
    if (item) {
      item.status = "processing";
      item.attemptCount = attempt;
      item.error = error;
    }
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
    if (["pending", "qualified", "unqualified"].includes(data.status) && await this.findCurrentReferral(data.guildId, data.inviteeId)) {
      throw new Error("Dieses Mitglied hat bereits eine laufende Spielerwerbung.");
    }
    const referral: Referral = {
      id: this.referralId++,
      guildId: data.guildId,
      inviterDiscordId: data.inviterId,
      inviterDiscordName: data.inviterName,
      inviteeDiscordId: data.inviteeId,
      inviteeDiscordName: data.inviteeName,
      inviteCode: data.inviteCode,
      joinedAt: data.joinedAt,
      status: data.status,
      qualifiedAt: data.status === "qualified" ? new Date() : null,
      leftAt: null,
      inviterEosId: null,
      invitedEosId: null,
      startMinutes: null,
      rewardStatus: "pending",
      blockedReason: null,
      rewardedCompletedAt: null
    };
    this.referrals.push(referral);
    this.events.push({ referralId: referral.id, eventType: "join_resolved", oldStatus: null, newStatus: data.status, actorId: null, reason: data.reason, createdAt: new Date() });
    await this.saveSnapshots(snapshots, "join_processed");
    const queued = this.queue.find((item) => item.id === queueId);
    if (queued) queued.status = "resolved";
    this.addLog(data.status === "unresolved" ? "warn" : "info", `referral_${data.status}`, this.referralLogDetails(data.inviteeId, data.inviterId, data.status, data.reason));
    return referral.id;
  }

  public async findCurrentReferral(guildId: string, inviteeId: string): Promise<Referral | null> {
    return [...this.referrals].reverse().find((referral) =>
      referral.guildId === guildId &&
      referral.inviteeDiscordId === inviteeId &&
      ["pending", "qualified", "unqualified"].includes(referral.status)
    ) ?? null;
  }

  public async findLatestAssignableReferral(guildId: string, inviteeId: string): Promise<Referral | null> {
    return [...this.referrals].reverse().find((referral) =>
      referral.guildId === guildId &&
      referral.inviteeDiscordId === inviteeId &&
      ["unresolved", "non_referral"].includes(referral.status)
    ) ?? null;
  }

  public async transitionReferral(referral: Referral, nextStatus: ReferralStatus, eventType: string, actorId: string | null, reason: string): Promise<void> {
    const stored = this.referrals.find((entry) => entry.id === referral.id && entry.status === referral.status);
    if (!stored) throw new Error("Spielerwerbung wurde geändert, bevor der angeforderte Statuswechsel angewendet werden konnte.");
    const oldStatus = stored.status;
    stored.status = nextStatus;
    if (nextStatus === "qualified" && !stored.qualifiedAt) stored.qualifiedAt = new Date();
    if (nextStatus === "left") stored.leftAt = new Date();
    this.events.push({ referralId: stored.id, eventType, oldStatus, newStatus: nextStatus, actorId, reason, createdAt: new Date() });
    this.addLog("info", eventType, this.referralLogDetails(stored.inviteeDiscordId, stored.inviterDiscordId, nextStatus, reason));
  }

  public async assignReferral(referral: Referral, inviterId: string, inviterName: string | null, inviteeName: string | null, nextStatus: "pending" | "qualified", adminId: string, reason: string): Promise<void> {
    const stored = this.referrals.find((entry) => entry.id === referral.id && ["unresolved", "non_referral"].includes(entry.status));
    if (!stored) throw new Error("Spielerwerbung kann nicht mehr zugeordnet werden.");
    const oldStatus = stored.status;
    stored.inviterDiscordId = inviterId;
    stored.inviterDiscordName = inviterName;
    stored.inviteeDiscordName = inviteeName ?? stored.inviteeDiscordName;
    stored.status = nextStatus;
    stored.qualifiedAt = nextStatus === "qualified" ? new Date() : null;
    this.events.push({ referralId: stored.id, eventType: "admin_assign", oldStatus, newStatus: nextStatus, actorId: adminId, reason, createdAt: new Date() });
    this.addLog("info", "admin_assign", this.referralLogDetails(stored.inviteeDiscordId, inviterId, nextStatus, reason));
  }

  public async listQualifiedByInviter(guildId: string, inviterId: string): Promise<Referral[]> {
    return this.referrals.filter((referral) => referral.guildId === guildId && referral.inviterDiscordId === inviterId && referral.status === "qualified")
      .sort((left, right) => right.joinedAt.getTime() - left.joinedAt.getTime());
  }

  public async getRanking(guildId: string, period: { start: Date; end: Date } | null, limit: number): Promise<Array<{ inviterId: string; total: number }>> {
    const counts = new Map<string, number>();
    for (const referral of this.referrals) {
      if (
        referral.guildId === guildId &&
        referral.status === "qualified" &&
        referral.inviterDiscordId &&
        referral.qualifiedAt &&
        (!period || referral.qualifiedAt >= period.start && referral.qualifiedAt < period.end)
      ) {
        counts.set(referral.inviterDiscordId, (counts.get(referral.inviterDiscordId) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([inviterId, total]) => ({ inviterId, total })).sort((left, right) => right.total - left.total).slice(0, limit);
  }

  public async listReferralHistory(guildId: string, inviteeId: string): Promise<Referral[]> {
    return this.referrals.filter((referral) => referral.guildId === guildId && referral.inviteeDiscordId === inviteeId).slice(-25).reverse();
  }

  public async listRunningReferrals(guildId: string): Promise<Referral[]> {
    return this.referrals.filter((referral) => referral.guildId === guildId && ["pending", "qualified", "unqualified"].includes(referral.status));
  }

  public async listRewardReferrals(guildId: string): Promise<Referral[]> {
    return this.referrals.filter((referral) =>
      referral.guildId === guildId &&
      referral.status === "qualified" &&
      referral.inviterDiscordId &&
      ["pending", "active"].includes(referral.rewardStatus)
    );
  }

  public setRewardSteps(steps: ReferralRewardStep[]): void {
    this.rewardSteps = steps;
  }

  public async listRewardSteps(): Promise<ReferralRewardStep[]> {
    return this.rewardSteps.filter((step) => step.enabled).sort((left, right) => left.requiredMinutes - right.requiredMinutes);
  }

  public async findRewardReferralByInvitee(guildId: string, inviteeId: string): Promise<Referral | null> {
    return [...this.referrals].reverse().find((referral) => referral.guildId === guildId && referral.inviteeDiscordId === inviteeId) ?? null;
  }

  public async hasExistingRewardReferral(guildId: string, inviteeId: string, excludeReferralId?: number): Promise<boolean> {
    return this.referrals.some((referral) =>
      referral.guildId === guildId &&
      referral.inviteeDiscordId === inviteeId &&
      referral.id !== excludeReferralId &&
      ["pending", "active", "completed"].includes(referral.rewardStatus)
    );
  }

  public async hasExistingRewardReferralForEos(guildId: string, invitedEosId: string, excludeReferralId?: number): Promise<boolean> {
    return this.referrals.some((referral) =>
      referral.guildId === guildId &&
      referral.invitedEosId === invitedEosId &&
      referral.id !== excludeReferralId &&
      ["active", "completed", "blocked"].includes(referral.rewardStatus)
    );
  }

  public async rememberPlayerIdentity(guildId: string, discordId: string, _discordName: string | null, eosId: string): Promise<void> {
    this.identities.set(`${guildId}:${discordId}`, eosId);
  }

  public async findRememberedEosId(guildId: string, discordId: string): Promise<string | null> {
    return this.identities.get(`${guildId}:${discordId}`) ?? null;
  }

  public async hasRememberedEosId(guildId: string, eosId: string, excludeDiscordId?: string): Promise<boolean> {
    for (const [key, value] of this.identities) {
      const [storedGuildId, storedDiscordId] = key.split(":");
      if (storedGuildId === guildId && storedDiscordId !== excludeDiscordId && value === eosId) return true;
    }
    return false;
  }

  public async activateRewardReferral(referralId: number, inviterEosId: string, invitedEosId: string, startMinutes: number): Promise<boolean> {
    const referral = this.referrals.find((entry) => entry.id === referralId);
    if (!referral || referral.status !== "qualified" || referral.rewardStatus !== "pending") return false;
    if (await this.hasExistingRewardReferral(referral.guildId, referral.inviteeDiscordId, referral.id)) return false;
    if (await this.hasExistingRewardReferralForEos(referral.guildId, invitedEosId, referral.id)) return false;
    referral.inviterEosId = inviterEosId;
    referral.invitedEosId = invitedEosId;
    referral.startMinutes = startMinutes;
    referral.rewardStatus = "active";
    referral.blockedReason = null;
    return true;
  }

  public async updateRewardEos(referralId: number, inviterEosId: string | null, invitedEosId: string | null): Promise<void> {
    const referral = this.referrals.find((entry) => entry.id === referralId);
    if (!referral) return;
    referral.inviterEosId = inviterEosId ?? referral.inviterEosId;
    referral.invitedEosId = invitedEosId ?? referral.invitedEosId;
  }

  public async blockRewardReferral(referralId: number, reason: string, _actorId: string | null): Promise<void> {
    const referral = this.referrals.find((entry) => entry.id === referralId);
    if (!referral) return;
    referral.rewardStatus = "blocked";
    referral.blockedReason = reason;
    for (const step of this.steps.filter((entry) => entry.referralId === referralId && entry.status !== "paid")) step.status = "blocked";
    this.addLog("warn", "referral_reward_blocked", [
      `Spielerwerbung #${referralId} wurde blockiert.`,
      "",
      ...this.referralIdentityLines(referral),
      "",
      "Grund:",
      reason
    ].join("\n"));
  }

  public async unblockRewardReferral(referralId: number, _actorId: string | null): Promise<void> {
    const referral = this.referrals.find((entry) => entry.id === referralId);
    if (!referral || referral.rewardStatus !== "blocked") return;
    referral.rewardStatus = referral.startMinutes === null ? "pending" : "active";
    referral.blockedReason = null;
    for (const step of this.steps.filter((entry) => entry.referralId === referralId && entry.status === "blocked")) step.status = "pending";
    this.addLog("info", "referral_reward_unblocked", [
      `Spielerwerbung #${referralId} wurde entsperrt.`,
      "",
      ...this.referralIdentityLines(referral)
    ].join("\n"));
  }

  public async completeRewardReferral(referralId: number): Promise<void> {
    const referral = this.referrals.find((entry) => entry.id === referralId && entry.rewardStatus === "active");
    if (referral) {
      referral.rewardStatus = "completed";
      referral.rewardedCompletedAt = new Date();
    }
  }

  public async ensureStepProgress(referralId: number, stepKey: string, requiredMinutes: number): Promise<ReferralStepProgress> {
    let step = this.steps.find((entry) => entry.referralId === referralId && entry.stepKey === stepKey);
    if (!step) {
      step = {
        id: this.stepId++,
        referralId,
        stepKey,
        requiredMinutes,
        status: "pending",
        attemptCount: 0,
        nextRetryAt: null,
        lastError: null,
        paidAt: null,
        createdAt: new Date()
      };
      this.steps.push(step);
    }
    step.requiredMinutes = requiredMinutes;
    return step;
  }

  public async listStepProgress(referralId: number): Promise<ReferralStepProgress[]> {
    return this.steps.filter((step) => step.referralId === referralId).sort((left, right) => left.requiredMinutes - right.requiredMinutes);
  }

  public async markStepPaid(referralId: number, stepKey: string): Promise<void> {
    const step = this.steps.find((entry) => entry.referralId === referralId && entry.stepKey === stepKey);
    if (!step) return;
    if (step.status !== "paid") {
      step.status = "paid";
      step.paidAt = new Date();
      step.lastError = null;
    }
  }

  public async markStepRetry(referralId: number, stepKey: string, attemptCount: number, nextRetryAt: Date, error: string): Promise<void> {
    const step = this.steps.find((entry) => entry.referralId === referralId && entry.stepKey === stepKey);
    if (!step) return;
    if (step.status === "paid") return;
    step.status = "retry";
    step.attemptCount = attemptCount;
    step.nextRetryAt = nextRetryAt;
    step.lastError = error;
  }

  public async markStepFailed(referralId: number, stepKey: string, attemptCount: number, error: string): Promise<void> {
    const step = this.steps.find((entry) => entry.referralId === referralId && entry.stepKey === stepKey);
    if (!step) return;
    if (step.status === "paid") return;
    step.status = "failed";
    step.attemptCount = attemptCount;
    step.nextRetryAt = null;
    step.lastError = error;
  }

  public async resetStepForRetry(referralId: number, stepKey: string): Promise<void> {
    const step = this.steps.find((entry) => entry.referralId === referralId && entry.stepKey === stepKey);
    if (step && step.status !== "paid") {
      step.status = "pending";
      step.nextRetryAt = null;
      step.lastError = null;
    }
  }

  public async logRewardPayout(log: ReferralRewardLog): Promise<void> {
    this.rewardLogs.push(log);
  }

  public async logInfo(eventType: string, _discordUserId: string | null, _referralId: number | null, details: string): Promise<void> {
    this.addLog("info", eventType, details.slice(0, 4000));
  }

  public async deleteExpiredHistory(retentionDays: number): Promise<void> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const referral of this.referrals) {
      if (["left", "revoked"].includes(referral.status) && (referral.leftAt?.getTime() ?? referral.joinedAt.getTime()) < cutoff) {
        referral.inviterDiscordId = null;
        referral.inviterDiscordName = null;
        referral.inviteeDiscordId = `anon-${referral.id}`;
        referral.inviteeDiscordName = null;
        referral.inviteCode = null;
      }
    }
  }

  public async logError(eventType: string, details: string): Promise<void> {
    this.addLog("error", eventType, details.slice(0, 4000));
  }

  public async savePanelMessage(panelType: PanelMessageType, guildId: string, channelId: string, messageId: string): Promise<void> {
    this.panels.set(`${guildId}:${panelType}`, { channelId, messageId });
  }

  public async getPanelMessage(panelType: PanelMessageType, guildId: string): Promise<{ channelId: string; messageId: string } | null> {
    return this.panels.get(`${guildId}:${panelType}`) ?? null;
  }

  public async pendingLogs(limit = 25): Promise<PendingLog[]> {
    const now = Date.now();
    return this.logs.filter((log) =>
      log.discordDeliveryStatus !== "sent" &&
      (!log.nextAttemptAt || log.nextAttemptAt.getTime() <= now)
    ).slice(0, limit);
  }

  public async markLogSent(id: number): Promise<void> {
    const log = this.logs.find((entry) => entry.id === id);
    if (log) log.discordDeliveryStatus = "sent";
  }

  public async markLogFailed(id: number, attempt: number, retryAt: Date, error: string): Promise<void> {
    const log = this.logs.find((entry) => entry.id === id);
    if (log) {
      log.discordDeliveryStatus = "failed";
      log.discord_attempt_count = attempt;
      log.nextAttemptAt = retryAt;
      log.lastError = error;
    }
  }

  public async latestMigration(): Promise<string | null> {
    return "memory-mock (keine SQL-Migration)";
  }

  public async queueLength(): Promise<number> {
    return this.queue.filter((item) => item.status === "queued" || item.status === "processing").length;
  }

  public async latestSnapshotTime(): Promise<Date | null> {
    const dates = Array.from(this.snapshots.values(), (snapshot) => snapshot.capturedAt.getTime());
    return dates.length ? new Date(Math.max(...dates)) : null;
  }

  public async latestError(): Promise<string | null> {
    const log = [...this.logs].reverse().find((entry) => entry.severity === "error");
    return log ? `${log.event_type} (${log.createdAt.toISOString()})` : null;
  }

  private addLog(severity: "info" | "warn" | "error", eventType: string, details: string): void {
    this.logs.push({
      id: this.logId++,
      severity,
      event_type: eventType,
      details,
      discord_attempt_count: 0,
      discordDeliveryStatus: "pending",
      nextAttemptAt: null,
      lastError: null,
      createdAt: new Date()
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

  private referralIdentityLines(referral: Referral): string[] {
    return [
      "Eingeladener Spieler:",
      this.displayUser(referral.inviteeDiscordId, referral.inviteeDiscordName),
      "",
      "Eingeladen von:",
      referral.inviterDiscordId ? this.displayUser(referral.inviterDiscordId, referral.inviterDiscordName) : "unbekannt"
    ];
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
