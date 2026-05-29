export type InviteStatus = "active" | "deleted" | "replaced";
export type ReferralStatus =
  | "pending"
  | "qualified"
  | "unqualified"
  | "left"
  | "unresolved"
  | "revoked"
  | "non_referral";
export type RewardReferralStatus = "pending" | "active" | "completed" | "blocked";
export type ReferralStepStatus = "pending" | "retry" | "paid" | "failed" | "blocked";
export type RewardLogStatus = "dry_run" | "success" | "failed";
export type RewardTargetType = "inviter" | "invited";
export type RewardDeliveryMode = "global" | "online_server";

export interface UserInvite {
  id: number;
  guildId: string;
  inviterDiscordId: string;
  inviteCode: string;
  channelId: string;
  status: InviteStatus;
  createdAt: Date;
}

export interface Referral {
  id: number;
  guildId: string;
  inviterDiscordId: string | null;
  inviterDiscordName: string | null;
  inviteeDiscordId: string;
  inviteeDiscordName: string | null;
  inviteCode: string | null;
  joinedAt: Date;
  status: ReferralStatus;
  qualifiedAt: Date | null;
  leftAt: Date | null;
  inviterEosId: string | null;
  invitedEosId: string | null;
  startMinutes: number | null;
  rewardStatus: RewardReferralStatus;
  blockedReason: string | null;
  rewardedCompletedAt: Date | null;
}

export interface InviteUseSnapshot {
  inviteCode: string;
  knownUses: number;
}

export interface ReferralStepProgress {
  id: number;
  referralId: number;
  stepKey: string;
  requiredMinutes: number;
  status: ReferralStepStatus;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface ReferralRewardLog {
  referralId: number;
  stepKey: string;
  targetType: RewardTargetType;
  discordId: string;
  eosId: string;
  command: string;
  status: RewardLogStatus;
  errorMessage: string | null;
}

export interface ReferralRewardClaim {
  id: number;
  claimCode: string;
  referralId: number;
  stepKey: string;
  targetType: RewardTargetType;
  discordId: string;
  eosId: string;
  availableAt: Date;
  expiresAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferralRewardStep {
  key: string;
  requiredMinutes: number;
  rewards: ReferralRewardDefinition[];
  enabled: boolean;
}

export interface ReferralRewardDefinition {
  key: string;
  label?: string;
  targetType: RewardTargetType;
  deliveryMode: RewardDeliveryMode;
  commands: string[];
}
