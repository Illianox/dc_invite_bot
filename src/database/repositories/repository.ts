import type {
  Referral,
  ReferralRewardLog,
  ReferralRewardStep,
  ReferralStatus,
  ReferralStepProgress,
  ReferralStepStatus,
  RewardReferralStatus,
  UserInvite
} from "../../utils/domain.js";

export interface PendingLog {
  id: number;
  severity: "info" | "warn" | "error";
  event_type: string;
  details: string;
  discord_attempt_count: number;
}

export type PanelMessageType = "main_panel" | "public_ranking_monthly" | "public_ranking_all_time";

export interface Repository {
  findActiveInvite(guildId: string, inviterId: string): Promise<UserInvite | null>;
  listActiveInvites(guildId: string): Promise<UserInvite[]>;
  createInvite(guildId: string, inviterId: string, inviteCode: string, channelId: string, knownUses: number): Promise<void>;
  markInviteDeleted(invite: UserInvite): Promise<void>;
  loadSnapshotMap(): Promise<Map<string, number>>;
  saveSnapshots(uses: Map<string, number>, reason: "startup" | "join_processed" | "invite_created" | "recovery"): Promise<void>;
  enqueueJoin(guildId: string, inviteeId: string, inviteeName: string | null, joinedAt: Date): Promise<number>;
  recoverOpenJoins(guildId: string): Promise<number>;
  setQueueAttempt(id: number, attempt: number, nextAttemptAt: Date | null, error: string | null): Promise<void>;
  resolveQueuedJoin(
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
  ): Promise<number>;
  findCurrentReferral(guildId: string, inviteeId: string): Promise<Referral | null>;
  findLatestAssignableReferral(guildId: string, inviteeId: string): Promise<Referral | null>;
  transitionReferral(referral: Referral, nextStatus: ReferralStatus, eventType: string, actorId: string | null, reason: string): Promise<void>;
  assignReferral(referral: Referral, inviterId: string, inviterName: string | null, inviteeName: string | null, nextStatus: "pending" | "qualified", adminId: string, reason: string): Promise<void>;
  listQualifiedByInviter(guildId: string, inviterId: string): Promise<Referral[]>;
  getRanking(guildId: string, period: { start: Date; end: Date } | null, limit: number): Promise<Array<{ inviterId: string; total: number }>>;
  listReferralHistory(guildId: string, inviteeId: string): Promise<Referral[]>;
  listRunningReferrals(guildId: string): Promise<Referral[]>;
  listRewardReferrals(guildId: string): Promise<Referral[]>;
  listRewardSteps(): Promise<ReferralRewardStep[]>;
  findRewardReferralByInvitee(guildId: string, inviteeId: string): Promise<Referral | null>;
  hasExistingRewardReferral(guildId: string, inviteeId: string, excludeReferralId?: number): Promise<boolean>;
  hasExistingRewardReferralForEos(guildId: string, invitedEosId: string, excludeReferralId?: number): Promise<boolean>;
  rememberPlayerIdentity(guildId: string, discordId: string, discordName: string | null, eosId: string): Promise<void>;
  findRememberedEosId(guildId: string, discordId: string): Promise<string | null>;
  hasRememberedEosId(guildId: string, eosId: string, excludeDiscordId?: string): Promise<boolean>;
  activateRewardReferral(referralId: number, inviterEosId: string, invitedEosId: string, startMinutes: number): Promise<boolean>;
  updateRewardEos(referralId: number, inviterEosId: string | null, invitedEosId: string | null): Promise<void>;
  blockRewardReferral(referralId: number, reason: string, actorId: string | null): Promise<void>;
  unblockRewardReferral(referralId: number, actorId: string | null): Promise<void>;
  completeRewardReferral(referralId: number): Promise<void>;
  ensureStepProgress(referralId: number, stepKey: string, requiredMinutes: number): Promise<ReferralStepProgress>;
  listStepProgress(referralId: number): Promise<ReferralStepProgress[]>;
  markStepPaid(referralId: number, stepKey: string): Promise<void>;
  markStepRetry(referralId: number, stepKey: string, attemptCount: number, nextRetryAt: Date, error: string): Promise<void>;
  markStepFailed(referralId: number, stepKey: string, attemptCount: number, error: string): Promise<void>;
  resetStepForRetry(referralId: number, stepKey: string): Promise<void>;
  logRewardPayout(log: ReferralRewardLog): Promise<void>;
  logInfo(eventType: string, discordUserId: string | null, referralId: number | null, details: string): Promise<void>;
  deleteExpiredHistory(retentionDays: number): Promise<void>;
  logError(eventType: string, details: string): Promise<void>;
  savePanelMessage(panelType: PanelMessageType, guildId: string, channelId: string, messageId: string): Promise<void>;
  getPanelMessage(panelType: PanelMessageType, guildId: string): Promise<{ channelId: string; messageId: string } | null>;
  pendingLogs(limit?: number): Promise<PendingLog[]>;
  markLogSent(id: number): Promise<void>;
  markLogFailed(id: number, attempt: number, retryAt: Date, error: string): Promise<void>;
  latestMigration(): Promise<string | null>;
  queueLength(): Promise<number>;
  latestSnapshotTime(): Promise<Date | null>;
  latestError(): Promise<string | null>;
}
