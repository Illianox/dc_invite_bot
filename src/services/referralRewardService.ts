import type { Referral, ReferralRewardDefinition, ReferralRewardStep, ReferralStepProgress } from "../utils/domain.js";
import type { RconServerConfig, ReferralRewardsConfig } from "../config/referralRewards.js";
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
      const rewardSteps = await this.rewardSteps(config);
      for (const referral of await this.repository.listRewardReferrals(guildId)) {
        checked++;
        paid += await this.checkReferral(referral, config, rewardSteps);
      }
      return { checked, paid };
    } finally {
      this.running = false;
    }
  }

  public async checkOne(guildId: string, inviteeId: string): Promise<{ checked: number; paid: number }> {
    const config = await this.currentConfig();
    if (!config.enabled) return { checked: 0, paid: 0 };
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral || referral.status !== "qualified" || !referral.inviterDiscordId || !["pending", "active"].includes(referral.rewardStatus)) {
      return { checked: 0, paid: 0 };
    }
    return { checked: 1, paid: await this.checkReferral(referral, config, await this.rewardSteps(config)) };
  }

  public async forceReward(guildId: string, inviteeId: string, stepKey: string): Promise<string> {
    const config = await this.currentConfig();
    const referral = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!referral) return "Keine Spielerwerbungs-Daten für dieses Mitglied gefunden.";
    const step = (await this.rewardSteps(config)).find((entry) => entry.key === stepKey);
    if (!step) return `Unbekannte Etappe: ${stepKey}`;
    await this.ensureActive(referral);
    const fresh = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
    if (!fresh || fresh.rewardStatus !== "active") return "Spielerwerbung ist nicht aktiv oder wurde blockiert.";
    let paid = 0;
    for (const reward of step.rewards) {
      await this.repository.resetStepForRetry(fresh.id, reward.key);
      const progress = await this.repository.ensureStepProgress(fresh.id, reward.key, step.requiredMinutes);
      if (progress.status === "paid") continue;
      if (await this.payReward(fresh, step, reward, progress, config, true)) paid++;
    }
    if (paid > 0) {
      const updated = await this.repository.findRewardReferralByInvitee(guildId, inviteeId);
      if (updated) await this.logProgressSummary(updated, step.rewards.map((reward) => reward.key), false, await this.rewardSteps(config));
    }
    return paid > 0 ? `Etappe ${step.key} wurde verarbeitet.` : "Keine offene Belohnung für diese Etappe verarbeitet.";
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
    if (!referral) return "Keine Spielerwerbungs-Daten für dieses Mitglied gefunden.";
    const current = referral.invitedEosId ? await this.stats.getMinutesPlayed(referral.invitedEosId) : null;
    const progress = await this.repository.listStepProgress(referral.id);
    return [
      `Spielerwerbungs-Fortschritt #${referral.id}`,
      `Eingeladen von: ${referral.inviterDiscordId ? `<@${referral.inviterDiscordId}>` : "unbekannt"}`,
      `Eingeladener Spieler: <@${referral.inviteeDiscordId}>`,
      `Status: ${statusLabel(referral.status)} / ${statusLabel(referral.rewardStatus)}`,
      `Werber EOS: ${referral.inviterEosId ?? "unbekannt"}`,
      `Geworbener Spieler EOS: ${referral.invitedEosId ?? "unbekannt"}`,
      `Start-Spielzeit: ${formatOptionalMinutes(referral.startMinutes)}`,
      `Aktuelle Spielzeit: ${formatOptionalMinutes(current)}`,
      `Spielzeit seit Start: ${current !== null && referral.startMinutes !== null ? current - referral.startMinutes : "unbekannt"}`,
      `Etappen: ${progress.length ? progress.map((step) => `${step.stepKey}:${step.status}`).join(", ") : "noch keine"}`
    ].join("\n");
  }

  private async rewardSteps(config: ReferralRewardsConfig): Promise<ReferralRewardStep[]> {
    return config.rewards.length
      ? config.rewards
          .filter((step) => step.enabled)
          .map((step) => ({
            key: step.key,
            requiredMinutes: step.requiredMinutes,
            enabled: step.enabled,
            rewards: step.rewards.map((reward) => ({
              key: reward.key,
              targetType: reward.target,
              deliveryMode: reward.mode,
              commands: reward.commands
            }))
          }))
          .sort((left, right) => left.requiredMinutes - right.requiredMinutes)
      : this.repository.listRewardSteps();
  }

  private async checkReferral(referral: Referral, config: ReferralRewardsConfig, rewardSteps: ReferralRewardStep[]): Promise<number> {
    const activated = await this.ensureActive(referral);
    const currentReferral = await this.repository.findRewardReferralByInvitee(referral.guildId, referral.inviteeDiscordId);
    if (!currentReferral || currentReferral.rewardStatus !== "active" || !currentReferral.invitedEosId || currentReferral.startMinutes === null) return 0;
    const currentMinutes = await this.stats.getMinutesPlayed(currentReferral.invitedEosId);
    if (currentMinutes === null) return 0;
    const earnedMinutes = currentMinutes - currentReferral.startMinutes;
    let paid = 0;
    const paidRewardKeys: string[] = [];
    for (const step of rewardSteps) {
      if (earnedMinutes < step.requiredMinutes) continue;
      for (const reward of step.rewards) {
        const progress = await this.repository.ensureStepProgress(currentReferral.id, reward.key, step.requiredMinutes);
        if (!this.isPayable(progress)) continue;
        if (await this.payReward(currentReferral, step, reward, progress, config, false)) {
          paid++;
          paidRewardKeys.push(reward.key);
        }
      }
    }
    const allProgress = await this.repository.listStepProgress(currentReferral.id);
    const allRewardKeys = rewardSteps.flatMap((step) => step.rewards.map((reward) => reward.key));
    const allPaid = allRewardKeys.length > 0 && allRewardKeys.every((rewardKey) => allProgress.some((progress) => progress.stepKey === rewardKey && progress.status === "paid"));
    if (allPaid) {
      await this.repository.completeRewardReferral(currentReferral.id);
    }
    if (activated) await this.logActivationSummary(currentReferral, rewardSteps);
    if (paid > 0 || allPaid) await this.logProgressSummary(currentReferral, paidRewardKeys, allPaid, rewardSteps);
    return paid;
  }

  private async ensureActive(referral: Referral): Promise<boolean> {
    if (referral.rewardStatus !== "pending") return false;
    if (!referral.inviterDiscordId || await this.repository.hasExistingRewardReferral(referral.guildId, referral.inviteeDiscordId, referral.id)) {
      await this.repository.blockRewardReferral(referral.id, "Eingeladener Spieler hat bereits eine Spielerwerbung oder der Werber ist unbekannt.", null);
      return false;
    }
    const [inviterEosId, invitedEosId] = await Promise.all([
      this.findAndRememberEosId(referral.guildId, referral.inviterDiscordId, referral.inviterDiscordName),
      this.findAndRememberEosId(referral.guildId, referral.inviteeDiscordId, referral.inviteeDiscordName)
    ]);
    await this.repository.updateRewardEos(referral.id, inviterEosId, invitedEosId);
    if (!inviterEosId || !invitedEosId) return false;
    if (inviterEosId === invitedEosId) {
      await this.repository.blockRewardReferral(referral.id, "Werber und geworbener Spieler haben dieselbe EOS ID.", null);
      return false;
    }
    if (await this.repository.hasExistingRewardReferralForEos(referral.guildId, invitedEosId, referral.id)) {
      await this.repository.blockRewardReferral(referral.id, "Diese EOS ID wurde bereits für eine Spielerwerbung verwendet.", null);
      return false;
    }
    if (await this.repository.hasRememberedEosId(referral.guildId, invitedEosId, referral.inviteeDiscordId)) {
      await this.repository.blockRewardReferral(referral.id, "Diese EOS ID war bereits mit einem anderen Discord-Account bekannt.", null);
      return false;
    }
    const startMinutes = await this.stats.getMinutesPlayed(invitedEosId);
    if (startMinutes === null) return false;
    return this.repository.activateRewardReferral(referral.id, inviterEosId, invitedEosId, startMinutes);
  }

  private async findAndRememberEosId(guildId: string, discordId: string, discordName: string | null): Promise<string | null> {
    const live = await this.stats.findEosId(discordId);
    if (live) {
      await this.repository.rememberPlayerIdentity(guildId, discordId, discordName, live);
      return live;
    }
    return this.repository.findRememberedEosId(guildId, discordId);
  }

  private isPayable(progress: ReferralStepProgress): boolean {
    if (progress.status === "paid" || progress.status === "blocked" || progress.status === "failed") return false;
    if (progress.status === "retry" && progress.nextRetryAt && progress.nextRetryAt.getTime() > Date.now()) return false;
    return true;
  }

  private async payReward(
    referral: Referral,
    step: ReferralRewardStep,
    reward: ReferralRewardDefinition,
    progress: ReferralStepProgress,
    config: ReferralRewardsConfig,
    forced: boolean
  ): Promise<boolean> {
    if (!referral.inviterDiscordId || !referral.inviterEosId || !referral.invitedEosId) return false;
    const target = reward.targetType === "inviter"
      ? { targetType: reward.targetType, discordId: referral.inviterDiscordId, eosId: referral.inviterEosId }
      : { targetType: reward.targetType, discordId: referral.inviteeDiscordId, eosId: referral.invitedEosId };
    const server = await this.resolveRewardServer(target.eosId, reward, config);
    if (!server) {
      await this.repository.markStepRetry(referral.id, reward.key, progress.attemptCount, new Date(Date.now() + config.retryDelaySeconds * 1000), "Spieler ist aktuell nicht online bestätigt.");
      return false;
    }
    const servers = reward.deliveryMode === "global" && config.multiServerRewards ? config.clusterServers : [server];
    const expandedCommands = reward.commands.flatMap((command) => servers.map((entryServer) => ({
      targetType: target.targetType,
      discordId: target.discordId,
      eosId: target.eosId,
      server: entryServer,
      command: renderCommand(command, target.eosId, target.discordId, referral.id, step.key)
    })));
    try {
      for (const entry of expandedCommands) {
        const result = await this.rcon.execute(entry.server, entry.command, config.dryRun);
        await this.repository.logRewardPayout({
          referralId: referral.id,
          stepKey: reward.key,
          targetType: entry.targetType,
          discordId: entry.discordId,
          eosId: entry.eosId,
          command: `[${result.serverName}] ${result.command}`,
          status: result.status,
          errorMessage: null
        });
      }
      const mode = config.dryRun ? "Dry-Run: " : "";
      if (config.dryRun) {
        await this.repository.logInfo(
          "referral_reward_dry_run",
          referral.inviteeDiscordId,
          referral.id,
          `${mode}Spielerwerbung würde verarbeitet\nEingeladen von: <@${referral.inviterDiscordId}>\nEingeladener Spieler: <@${referral.inviteeDiscordId}>\nBelohnung: ${reward.key}\nCommands:\n${expandedCommands.map((entry) => `[${entry.server.name}] ${entry.command}`).join("\n")}${forced ? "\nManuell ausgelöst." : ""}`
        );
      }
      if (config.dryRun) return false;
      await this.repository.markStepPaid(referral.id, reward.key);
      return true;
    } catch (error) {
      const message = String(error);
      for (const entry of expandedCommands) {
        await this.repository.logRewardPayout({
          referralId: referral.id,
          stepKey: reward.key,
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
        await this.repository.markStepFailed(referral.id, reward.key, nextAttempt, message);
        await this.repository.logError("referral_reward_failed", this.rewardFailureDetails(referral, reward.key, message, "endgültig fehlgeschlagen"));
      } else {
        await this.repository.markStepRetry(referral.id, reward.key, nextAttempt, new Date(Date.now() + config.retryDelaySeconds * 1000), message);
        await this.repository.logError("referral_reward_retry", this.rewardFailureDetails(referral, reward.key, message, `wird erneut versucht (${nextAttempt}/${config.maxRetryAttempts})`));
      }
      return false;
    }
  }

  private async resolveRewardServer(eosId: string, reward: ReferralRewardDefinition, config: ReferralRewardsConfig): Promise<RconServerConfig | null> {
    if (reward.deliveryMode === "global") return config.rewardServer;
    const location = await this.stats.findOnlineLocation(eosId, config.onlinePlayers);
    if (!location) return null;
    const server = config.clusterServers.find((entry) => entry.serverId === location.serverId || entry.name === location.mapName);
    if (!server) throw new Error(`Kein RCON-Server für Online-Server ${location.serverId} (${location.mapName}) konfiguriert.`);
    if (config.dryRun) return server;
    const response = await this.rcon.query(server, renderOnlineCheckCommand(config.onlineCheckCommand, eosId));
    const expected = config.onlineCheckResponseIncludes.replaceAll("{eos_id}", eosId);
    return response.includes(expected) ? server : null;
  }

  private async logProgressSummary(referral: Referral, paidRewardKeys: string[], completed: boolean, rewardSteps: ReferralRewardStep[]): Promise<void> {
    const [currentMinutes, progress] = await Promise.all([
      referral.invitedEosId ? this.stats.getMinutesPlayed(referral.invitedEosId) : Promise.resolve(null),
      this.repository.listStepProgress(referral.id)
    ]);
    const earnedMinutes = currentMinutes !== null && referral.startMinutes !== null
      ? Math.max(0, currentMinutes - referral.startMinutes)
      : null;
    const progressByKey = new Map(progress.map((entry) => [entry.stepKey, entry]));
    const nextStep = rewardSteps.find((step) => step.rewards.some((reward) => progressByKey.get(reward.key)?.status !== "paid"));
    const currentProgress = earnedMinutes === null
      ? "unbekannt"
      : nextStep
        ? `${formatShortMinutes(earnedMinutes)} / ${formatShortMinutes(nextStep.requiredMinutes)}`
        : formatShortMinutes(earnedMinutes);
    const paidRewards = paidRewardKeys.length
      ? paidRewardKeys.join(", ")
      : progress.filter((step) => step.status === "paid").map((step) => step.stepKey).join(", ") || "keine";
    await this.repository.logInfo("referral_reward_progress_updated", referral.inviteeDiscordId, referral.id, [
      "Werber:",
      referral.inviterDiscordId ? displayUser(referral.inviterDiscordId, referral.inviterDiscordName) : "unbekannt",
      "",
      "Geworbener Spieler:",
      displayUser(referral.inviteeDiscordId, referral.inviteeDiscordName),
      "",
      "Status:",
      completed ? "abgeschlossen" : statusLabel(referral.rewardStatus),
      "",
      "Aktuelle Spielzeit:",
      currentProgress,
      "",
      "Nächste Belohnung:",
      nextStep ? formatShortMinutes(nextStep.requiredMinutes) : "keine",
      "",
      "Verarbeitete Belohnungen:",
      paidRewards
    ].join("\n"));
  }

  private async logActivationSummary(referral: Referral, rewardSteps: ReferralRewardStep[]): Promise<void> {
    const nextStep = rewardSteps[0] ?? null;
    await this.repository.logInfo("referral_reward_active", referral.inviteeDiscordId, referral.id, [
      "Eingeladener Spieler:",
      displayUser(referral.inviteeDiscordId, referral.inviteeDiscordName),
      "",
      "Eingeladen von:",
      referral.inviterDiscordId ? displayUser(referral.inviterDiscordId, referral.inviterDiscordName) : "unbekannt",
      "",
      "Start-Spielzeit:",
      formatOptionalMinutes(referral.startMinutes),
      "",
      "Nächste Belohnung:",
      nextStep ? `${nextStep.key} (${formatShortMinutes(nextStep.requiredMinutes)})` : "keine",
      "",
      "Status:",
      "Spielerwerbung ist aktiv."
    ].join("\n"));
  }

  private rewardFailureDetails(referral: Referral, stepKey: string, error: string, status: string): string {
    return [
      "Werber:",
      referral.inviterDiscordId ? displayUser(referral.inviterDiscordId, referral.inviterDiscordName) : "unbekannt",
      "",
      "Geworbener Spieler:",
      displayUser(referral.inviteeDiscordId, referral.inviteeDiscordName),
      "",
      "Etappe:",
      stepKey,
      "",
      "Fehler:",
      error,
      "",
      "Status:",
      status
    ].join("\n");
  }
}

function renderCommand(template: string, eosId: string, discordId: string, referralId: number, stepKey: string): string {
  return template
    .replaceAll("{eos_id}", eosId)
    .replaceAll("{discord_id}", discordId)
    .replaceAll("{referral_id}", String(referralId))
    .replaceAll("{step_key}", stepKey);
}

function renderOnlineCheckCommand(template: string, eosId: string): string {
  return template.replaceAll("{eos_id}", eosId);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "aktiv",
    blocked: "blockiert",
    completed: "abgeschlossen",
    failed: "fehlgeschlagen",
    left: "verlassen",
    non_referral: "keine Spielerwerbung",
    paid: "verarbeitet",
    pending: "wartend",
    qualified: "erfolgreich",
    retry: "erneuter Versuch",
    revoked: "widerrufen",
    unqualified: "nicht erfolgreich",
    unresolved: "unklar"
  };
  return labels[status] ?? status;
}

function formatOptionalMinutes(minutes: number | null): string {
  if (minutes === null) return "unbekannt";
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `${hours} Stunden ${remaining} Minuten`;
}

function formatShortMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}h` : `${hours}h ${remaining}m`;
}

function displayUser(userId: string, userName: string | null): string {
  return userName ? `${userName} (<@${userId}>)` : `<@${userId}>`;
}
