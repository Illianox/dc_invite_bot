import type { Referral, ReferralRewardStep, ReferralStepProgress, RewardTargetType } from "../utils/domain.js";
import type { ReferralRewardsConfig } from "../config/referralRewards.js";
import { loadReferralRewardsConfig } from "../config/referralRewards.js";
import type { Repository } from "../database/repositories/repository.js";
import type { PlayerStatsReader } from "./playerStatsRepository.js";
import { RconRewardClient } from "./rconClient.js";

export class ReferralRewardService {
  private config: ReferralRewardsConfig | null = null;
  private running = false;

  public constructor(
    private readonly repository: Repository,
    private readonly stats: PlayerStatsReader,
    private readonly rcon: RconRewardClient,
    initialConfig: ReferralRewardsConfig | null = null
  ) {
    this.config = initialConfig;
  }

  public async reloadConfig(): Promise<ReferralRewardsConfig> {
    this.config = await loadReferralRewardsConfig();
    return this.config;
  }

  public async currentConfig(): Promise<ReferralRewardsConfig> {
    return this.config ?? this.reloadConfig();
  }

  public async checkAll(guildId: string): Promise<{ checked: number; paid: number }> {
    if (this.running) return { checked: 0, paid: 0 };
    this.running = true;
    try {
      const config = await this.currentConfig();
      if (!config.enabled) return { checked: 0, paid: 0 };
      let checked = 0;
      let paid = 0;
      const rewardSteps = await this.repository.listRewardSteps();
      for (const referral of await this.repository.listRewardReferrals(guildId)) {
        checked++;
        paid += await this.checkReferral(referral, config, rewardSteps);
      }
      return { checked, paid };
    } finally {
      this.running = false;
    }
  }

  public async forceReward(guildId: string, inviteeId: string, stepKey: string): Promise<string> {
    const config = await this.currentConfig();
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral) return "Keine Referral-Daten fuer dieses Mitglied gefunden.";
    const step = (await this.repository.listRewardSteps()).find((entry) => entry.key === stepKey);
    if (!step) return `Unbekannte Reward-Etappe: ${stepKey}`;
    await this.ensureActive(referral);
    const fresh = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!fresh || fresh.rewardStatus !== "active") return "Referral ist nicht aktiv oder wurde blockiert.";
    await this.repository.resetStepForRetry(fresh.id, step.key);
    const progress = await this.repository.ensureStepProgress(fresh.id, step.key, step.requiredMinutes);
    if (progress.status === "paid") return "Diese Etappe wurde bereits ausgezahlt.";
    await this.payStep(fresh, step, progress, config, true);
    return `Etappe ${step.key} wurde verarbeitet.`;
  }

  public async block(guildId: string, inviteeId: string, reason: string, actorId: string): Promise<boolean> {
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral) return false;
    await this.repository.blockRewardReferral(referral.id, reason, actorId);
    return true;
  }

  public async unblock(guildId: string, inviteeId: string, actorId: string): Promise<boolean> {
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral) return false;
    await this.repository.unblockRewardReferral(referral.id, actorId);
    return true;
  }

  public async info(guildId: string, inviteeId: string): Promise<string> {
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral) return "Keine Referral-Daten fuer dieses Mitglied gefunden.";
    const current = referral.invitedEosId ? await this.stats.getMinutesPlayed(referral.invitedEosId) : null;
    const progress = await this.repository.listStepProgress(referral.id);
    return [
      `Referral #${referral.id}`,
      `Inviter: ${referral.inviterDiscordId ? `<@${referral.inviterDiscordId}>` : "unbekannt"}`,
      `Invited: <@${referral.inviteeDiscordId}>`,
      `Status: ${referral.status} / Reward: ${referral.rewardStatus}`,
      `Inviter EOS: ${referral.inviterEosId ?? "unbekannt"}`,
      `Invited EOS: ${referral.invitedEosId ?? "unbekannt"}`,
      `Start-Minuten: ${referral.startMinutes ?? "unbekannt"}`,
      `Aktuelle MinutesPlayed: ${current ?? "unbekannt"}`,
      `Spielzeit seit Invite: ${current !== null && referral.startMinutes !== null ? current - referral.startMinutes : "unbekannt"}`,
      `Etappen: ${progress.length ? progress.map((step) => `${step.stepKey}:${step.status}`).join(", ") : "noch keine"}`
    ].join("\n");
  }

  private async checkReferral(referral: Referral, config: ReferralRewardsConfig, rewardSteps: ReferralRewardStep[]): Promise<number> {
    await this.ensureActive(referral);
    const currentReferral = await this.repository.findRewardReferralByInvitee(referral.guildId, referral.inviteeDiscordId);
    if (!currentReferral || currentReferral.rewardStatus !== "active" || !currentReferral.invitedEosId || currentReferral.startMinutes === null) return 0;
    const currentMinutes = await this.stats.getMinutesPlayed(currentReferral.invitedEosId);
    if (currentMinutes === null) return 0;
    const earnedMinutes = currentMinutes - currentReferral.startMinutes;
    let paid = 0;
    for (const step of rewardSteps) {
      const progress = await this.repository.ensureStepProgress(currentReferral.id, step.key, step.requiredMinutes);
      if (!this.isPayable(progress) || earnedMinutes < step.requiredMinutes) continue;
      await this.repository.logInfo("referral_reward_step_reached", currentReferral.inviteeDiscordId, currentReferral.id, `Referral #${currentReferral.id} hat Etappe ${step.key} erreicht. Spielzeit seit Invite: ${earnedMinutes} Minuten.`);
      if (await this.payStep(currentReferral, step, progress, config, false)) paid++;
    }
    const allProgress = await this.repository.listStepProgress(currentReferral.id);
    const allPaid = rewardSteps.length > 0 && rewardSteps.every((step) => allProgress.some((progress) => progress.stepKey === step.key && progress.status === "paid"));
    if (allPaid) {
      await this.repository.completeRewardReferral(currentReferral.id);
      await this.repository.logInfo("referral_reward_completed", currentReferral.inviteeDiscordId, currentReferral.id, `Referral #${currentReferral.id} wurde abgeschlossen.`);
    }
    return paid;
  }

  private async ensureActive(referral: Referral): Promise<void> {
    if (referral.rewardStatus !== "pending") return;
    if (!referral.inviterDiscordId || await this.repository.hasExistingRewardReferral(referral.guildId, referral.inviteeDiscordId, referral.id)) {
      await this.repository.blockRewardReferral(referral.id, "Eingeladener Spieler hat bereits ein Reward-Referral oder der Inviter ist unbekannt.", null);
      return;
    }
    const [inviterEosId, invitedEosId] = await Promise.all([
      this.findAndRememberEosId(referral.guildId, referral.inviterDiscordId),
      this.findAndRememberEosId(referral.guildId, referral.inviteeDiscordId)
    ]);
    await this.repository.updateRewardEos(referral.id, inviterEosId, invitedEosId);
    if (!inviterEosId || !invitedEosId) return;
    if (inviterEosId === invitedEosId) {
      await this.repository.blockRewardReferral(referral.id, "Inviter und Invited haben dieselbe EOS ID.", null);
      return;
    }
    if (await this.repository.hasExistingRewardReferralForEos(referral.guildId, invitedEosId, referral.id)) {
      await this.repository.blockRewardReferral(referral.id, "Diese EOS ID wurde bereits fuer ein Reward-Referral verwendet.", null);
      return;
    }
    if (await this.repository.hasRememberedEosId(referral.guildId, invitedEosId, referral.inviteeDiscordId)) {
      await this.repository.blockRewardReferral(referral.id, "Diese EOS ID war bereits mit einem anderen Discord-Account bekannt.", null);
      return;
    }
    const startMinutes = await this.stats.getMinutesPlayed(invitedEosId);
    if (startMinutes === null) return;
    await this.repository.activateRewardReferral(referral.id, inviterEosId, invitedEosId, startMinutes);
    await this.repository.logInfo("referral_reward_start_minutes_saved", referral.inviteeDiscordId, referral.id, `start_minutes fuer Referral #${referral.id} gespeichert: ${startMinutes}.`);
  }

  private async findAndRememberEosId(guildId: string, discordId: string): Promise<string | null> {
    const live = await this.stats.findEosId(discordId);
    if (live) {
      await this.repository.rememberPlayerIdentity(guildId, discordId, live);
      return live;
    }
    return this.repository.findRememberedEosId(guildId, discordId);
  }

  private isPayable(progress: ReferralStepProgress): boolean {
    if (progress.status === "paid" || progress.status === "blocked" || progress.status === "failed") return false;
    if (progress.status === "retry" && progress.nextRetryAt && progress.nextRetryAt.getTime() > Date.now()) return false;
    return true;
  }

  private async payStep(
    referral: Referral,
    step: ReferralRewardStep,
    progress: ReferralStepProgress,
    config: ReferralRewardsConfig,
    forced: boolean
  ): Promise<boolean> {
    if (!referral.inviterDiscordId || !referral.inviterEosId || !referral.invitedEosId) return false;
    const commands = [
      ...step.inviterCommands.map((command) => ({ targetType: "inviter" as const, discordId: referral.inviterDiscordId!, eosId: referral.inviterEosId!, command })),
      ...step.invitedCommands.map((command) => ({ targetType: "invited" as const, discordId: referral.inviteeDiscordId, eosId: referral.invitedEosId!, command }))
    ];
    const servers = config.multiServerRewards ? config.clusterServers : [config.rewardServer];
    const expandedCommands = commands.flatMap((entry) => servers.map((server) => ({ ...entry, server, command: renderCommand(entry.command, entry.eosId, entry.discordId, referral.id, step.key) })));
    try {
      for (const entry of expandedCommands) {
        const result = await this.rcon.execute(entry.server, entry.command, config.dryRun);
        await this.repository.logRewardPayout({
          referralId: referral.id,
          stepKey: step.key,
          targetType: entry.targetType,
          discordId: entry.discordId,
          eosId: entry.eosId,
          command: `[${result.serverName}] ${result.command}`,
          status: result.status,
          errorMessage: null
        });
      }
      const mode = config.dryRun ? "Dry-Run: " : "";
      await this.repository.logInfo(
        config.dryRun ? "referral_reward_dry_run" : "referral_reward_paid",
        referral.inviteeDiscordId,
        referral.id,
        `${mode}Referral Belohnung ausgezahlt\nInviter: <@${referral.inviterDiscordId}>\nInvited: <@${referral.inviteeDiscordId}>\nEtappe: ${step.key}\nCommands:\n${expandedCommands.map((entry) => `[${entry.server.name}] ${entry.command}`).join("\n")}${forced ? "\nManuell ausgeloest." : ""}`
      );
      if (config.dryRun) return false;
      await this.repository.markStepPaid(referral.id, step.key);
      return true;
    } catch (error) {
      const message = String(error);
      for (const entry of expandedCommands) {
        await this.repository.logRewardPayout({
          referralId: referral.id,
          stepKey: step.key,
          targetType: entry.targetType,
          discordId: entry.discordId,
          eosId: entry.eosId,
          command: `[${entry.server.name}] ${entry.command}`,
          status: "failed",
          errorMessage: message
        });
      }
      const nextAttempt = progress.attemptCount + 1;
      if (nextAttempt >= config.maxRetryAttempts) {
        await this.repository.markStepFailed(referral.id, step.key, nextAttempt, message);
        await this.repository.logError("referral_reward_failed", `Referral #${referral.id}, Etappe ${step.key}: ${message}`);
      } else {
        await this.repository.markStepRetry(referral.id, step.key, nextAttempt, new Date(Date.now() + config.retryDelaySeconds * 1000), message);
        await this.repository.logError("referral_reward_retry", `Referral #${referral.id}, Etappe ${step.key}: Versuch ${nextAttempt}/${config.maxRetryAttempts} fehlgeschlagen. ${message}`);
      }
      return false;
    }
  }
}

function renderCommand(template: string, eosId: string, discordId: string, referralId: number, stepKey: string): string {
  return template
    .replaceAll("{eos_id}", eosId)
    .replaceAll("{discord_id}", discordId)
    .replaceAll("{referral_id}", String(referralId))
    .replaceAll("{step_key}", stepKey);
}
