import {
  ChatInputCommandInteraction,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel
} from "discord.js";
import { BOT_VERSION, env } from "../config/env.js";
import type { PanelMessageType, Repository } from "../database/repositories/repository.js";
import { CooldownService } from "../services/cooldownService.js";
import { InviteService } from "../services/inviteService.js";
import type { PlayerStatsReader } from "../services/playerStatsRepository.js";
import { ReferralRewardService } from "../services/referralRewardService.js";
import { ReferralService, type RankingScope } from "../services/referralService.js";
import { mainPanel, rankingEmbed, referralsPage } from "../ui/embeds.js";
import type { Referral } from "../utils/domain.js";

export interface CommandDependencies {
  client: Client;
  repository: Repository;
  invites: InviteService;
  referrals: ReferralService;
  playerStats: PlayerStatsReader;
  rewards: ReferralRewardService;
  cooldowns: CooldownService;
  startedAt: number;
  storageMode: "mysql" | "memory";
  checkStorage: () => Promise<number>;
}

function hasAdminAccess(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
}

async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (hasAdminAccess(interaction)) return true;
  await interaction.reply({ content: "Dafuer fehlen dir die Berechtigungen.", flags: MessageFlags.Ephemeral });
  return false;
}

async function interactionMember(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

export async function handleCommand(interaction: ChatInputCommandInteraction, deps: CommandDependencies): Promise<void> {
  if (!interaction.inGuild() || interaction.guildId !== env.DISCORD_GUILD_ID) {
    await interaction.reply({ content: "Dieser Command ist nur im konfigurierten Server verfuegbar.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await requireAdmin(interaction))) return;

  if (interaction.commandName !== "rangliste") {
    const wait = deps.cooldowns.take(`admin:${interaction.user.id}`, env.ADMIN_COMMAND_COOLDOWN_MS);
    if (wait > 0) {
      await interaction.reply({ content: `Bitte warte noch ${Math.ceil(wait / 1000)} Sekunden.`, flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (interaction.commandName === "panel") {
    const channel = await interaction.guild!.channels.fetch(env.PANEL_CHANNEL_ID);
    if (!(channel instanceof TextChannel)) throw new Error("PANEL_CHANNEL_ID must be a text channel.");
    const stored = await deps.repository.getPanelMessage("main_panel", interaction.guildId);
    const message = stored
      ? await channel.messages.fetch(stored.messageId).catch(() => null)
      : null;
    const published = message ? await message.edit(mainPanel()) : await channel.send(mainPanel());
    await deps.repository.savePanelMessage("main_panel", interaction.guildId, channel.id, published.id);
    await interaction.reply({ content: "Das Spieler werben Spieler Panel wurde veroeffentlicht oder aktualisiert.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "rangliste") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = await interaction.guild!.channels.fetch(env.RANKING_CHANNEL_ID);
    if (!(channel instanceof TextChannel)) throw new Error("RANKING_CHANNEL_ID must be a text channel.");
    const scope = (interaction.options.getString("rangliste") ?? "monthly") as RankingScope;
    const embed = rankingEmbed(await deps.referrals.activeRanking(interaction.guild!, scope), scope);
    const panelType = rankingPanelType(scope);
    const existing = await deps.repository.getPanelMessage(panelType, interaction.guildId);
    const previous = existing ? await channel.messages.fetch(existing.messageId).catch(() => null) : null;
    const updated = previous ? await previous.edit({ embeds: [embed] }).catch(() => null) : null;
    const message = updated ?? await channel.send({ embeds: [embed] });
    await deps.repository.savePanelMessage(panelType, interaction.guildId, channel.id, message.id);
    await interaction.editReply("Das oeffentliche Ranking wurde veroeffentlicht oder aktualisiert.");
    return;
  }

  if (interaction.commandName === "referral") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "list") {
      const rows = await deps.repository.listRewardReferrals(interaction.guildId);
      const lines = rows.slice(0, 20).map((row) => `#${row.id} ${row.rewardStatus} - Geworben von ${row.inviterDiscordId ? `<@${row.inviterDiscordId}>` : "unbekannt"} / Geworbener Spieler <@${row.inviteeDiscordId}> / Start ${row.startMinutes ?? "offen"}`);
      await interaction.reply({ content: lines.length ? lines.join("\n") : "Keine offenen oder aktiven Spielerwerbungen gefunden.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "forcecheck") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await deps.rewards.checkAll(interaction.guildId);
      await interaction.editReply(`Spielerwerbungs-Pruefung abgeschlossen. Geprueft: ${result.checked}, verarbeitete Etappen: ${result.paid}.`);
      return;
    }
    if (subcommand === "reload") {
      const config = await deps.rewards.reloadConfig();
      const steps = await deps.repository.listRewardSteps();
      await interaction.reply({ content: `Spielerwerbungs-Config neu geladen. dryRun=${config.dryRun}, mehrereServer=${config.multiServerRewards}, aktive DB-Etappen=${steps.length}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const target = interaction.options.getUser("member", true);
    if (subcommand === "info") {
      await interaction.reply({ content: await deps.rewards.info(interaction.guildId, target.id), flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "block") {
      const reason = interaction.options.getString("grund", true);
      const blocked = await deps.rewards.block(interaction.guildId, target.id, reason, interaction.user.id);
      await interaction.reply({ content: blocked ? "Spielerwerbung wurde blockiert." : "Keine Spielerwerbungs-Daten fuer dieses Mitglied gefunden.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "unblock") {
      const unblocked = await deps.rewards.unblock(interaction.guildId, target.id, interaction.user.id);
      await interaction.reply({ content: unblocked ? "Spielerwerbung wurde entsperrt." : "Keine Spielerwerbungs-Daten fuer dieses Mitglied gefunden.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "forcereward") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stepKey = interaction.options.getString("step_key", true);
      await interaction.editReply(await deps.rewards.forceReward(interaction.guildId, target.id, stepKey));
      return;
    }
    if (subcommand === "inspect") {
      const history = await deps.repository.listReferralHistory(interaction.guildId, target.id);
      const lines = history.map((row) => `#${row.id} ${row.status} - <t:${Math.floor(row.joinedAt.getTime() / 1000)}:f>`).join("\n");
      await interaction.reply({ content: lines || "Keine Spielerwerbungs-Daten fuer dieses Mitglied gefunden.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === "assign") {
      const inviter = interaction.options.getUser("inviter", true);
      const reason = interaction.options.getString("reason", true);
      const [member, inviterMember] = await Promise.all([
        interaction.guild!.members.fetch(target.id).catch(() => null),
        interaction.guild!.members.fetch(inviter.id).catch(() => null)
      ]);
      if (!member || !inviterMember || member.user.bot || inviterMember.user.bot || member.id === inviterMember.id || !deps.referrals.isLinked(inviterMember)) {
        await interaction.reply({ content: "Diese Zuordnung ist nicht zulaessig. Pruefe Mitglieder, Bots, Selbstzuordnung und Linked-Status des Werbers.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (await deps.repository.findCurrentReferral(interaction.guildId, target.id)) {
        await interaction.reply({ content: "Dieses Mitglied hat bereits eine laufende Spielerwerbung.", flags: MessageFlags.Ephemeral });
        return;
      }
      const unresolved = await deps.repository.findLatestAssignableReferral(interaction.guildId, target.id);
      if (!unresolved) {
        await interaction.reply({ content: "Es gibt keinen ungeklaerten Datensatz zur Zuordnung.", flags: MessageFlags.Ephemeral });
        return;
      }
      const status = deps.referrals.isQualified(member) ? "qualified" : "pending";
      await deps.repository.assignReferral(unresolved, inviter.id, memberDisplayName(inviterMember), memberDisplayName(member), status, interaction.user.id, reason);
      await interaction.reply({ content: `Spielerwerbung wurde als \`${statusLabel(status)}\` zugeordnet.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const reason = interaction.options.getString("reason", true);
    const active = await deps.repository.findCurrentReferral(interaction.guildId, target.id);
    if (!active) {
      await interaction.reply({ content: "Keine laufende Spielerwerbung gefunden.", flags: MessageFlags.Ephemeral });
      return;
    }
    await deps.repository.transitionReferral(active, "revoked", "admin_revoke", interaction.user.id, reason);
    await interaction.reply({ content: "Spielerwerbung wurde widerrufen.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "system") {
    const [latency, migration, queueLength, latestSnapshot, latestError] = await Promise.all([
      deps.checkStorage(),
      deps.repository.latestMigration(),
      deps.repository.queueLength(),
      deps.repository.latestSnapshotTime(),
      deps.repository.latestError()
    ]);
    const lastSync = deps.invites.getLastSuccessfulSync();
    const uptime = Math.floor((Date.now() - deps.startedAt) / 1000);
    await interaction.reply({
      content: [
        `Bot-Version: \`${BOT_VERSION}\``,
        `Datenspeicher: \`${deps.storageMode === "memory" ? "Memory-Mock (wird beim Neustart geloescht)" : "MySQL/MariaDB"}\``,
        `Uptime: \`${uptime}s\``,
        `Speicher-Latenz: \`${latency}ms\``,
        `Letzte Migration: \`${migration ?? "keine"}\``,
        `Letzter erfolgreicher Sync: \`${lastSync?.toISOString() ?? "noch keiner"}\``,
        `Letzter Einladungs-Snapshot: \`${latestSnapshot?.toISOString() ?? "noch keiner"}\``,
        `Offene DB-Queue: \`${queueLength}\``,
        `Aktive lokale Join-Verarbeitung: \`${deps.invites.queueSize()}\``,
        `Letzter Fehler: \`${latestError ?? "keiner"}\``
      ].join("\n"),
      flags: MessageFlags.Ephemeral
    });
  }
}

function rankingPanelType(scope: RankingScope): PanelMessageType {
  return scope === "monthly" ? "public_ranking_monthly" : "public_ranking_all_time";
}

function statusLabel(status: "pending" | "qualified"): string {
  return status === "qualified" ? "erfolgreich" : "wartend";
}

function memberDisplayName(member: GuildMember): string {
  return member.displayName && member.displayName !== member.user.username
    ? `${member.displayName} (${member.user.tag})`
    : member.user.tag;
}

export async function handleButton(interaction: ButtonInteraction, deps: CommandDependencies): Promise<void> {
  if (!interaction.inGuild() || interaction.guildId !== env.DISCORD_GUILD_ID) return;
  const member = await interactionMember(interaction);
  if (!member || member.user.bot) {
    await interaction.reply({ content: "Bots koennen diese Funktion nicht verwenden.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.customId === "invite:mine") {
    if (!deps.referrals.isLinked(member)) {
      await interaction.reply({ content: "Du benoetigst zuerst die Rolle `Linked` aus dem bestehenden Verknuepfungs-System.", flags: MessageFlags.Ephemeral });
      return;
    }
    const stored = await deps.repository.findActiveInvite(interaction.guildId, member.id);
    if (!stored) {
      const wait = deps.cooldowns.take(`invite-create:${member.id}`, env.INVITE_CREATION_COOLDOWN_MS);
      if (wait > 0) {
        await interaction.reply({ content: `Bitte warte ${Math.ceil(wait / 1000)} Sekunden vor einer neuen Link-Erstellung.`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const url = await deps.invites.getOrCreatePersonalInvite(interaction.guild!, member);
    await interaction.editReply(`Dein persoenlicher Einladungslink:\n${url}`);
    return;
  }

  if (interaction.customId.startsWith("referrals:")) {
    let requestedPage = 0;
    let expiresAt = Date.now() + env.PAGINATION_TIMEOUT_MS;
    if (interaction.customId.startsWith("referrals:page:")) {
      const [, , ownerId, page, expiration] = interaction.customId.split(":");
      if (ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Diese Navigation gehoert zu einer anderen privaten Ansicht.", flags: MessageFlags.Ephemeral });
        return;
      }
      requestedPage = Number(page);
      expiresAt = Number(expiration);
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
        await interaction.reply({ content: "Diese Seitennavigation ist abgelaufen. Oeffne `Meine geworbenen Spieler` erneut.", flags: MessageFlags.Ephemeral });
        return;
      }
    } else {
      const wait = deps.cooldowns.take(`referrals:${member.id}`, env.REFERRALS_VIEW_COOLDOWN_MS);
      if (wait > 0) {
        await interaction.reply({ content: `Bitte warte noch ${Math.ceil(wait / 1000)} Sekunden.`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    const data = await deps.referrals.listForInviter(interaction.guildId, member.id);
    const names = new Map<string, string>();
    const playtimes = new Map<string, number | null>();
    for (const referral of data) {
      const [referredMember, minutesPlayed] = await Promise.all([
        interaction.guild!.members.fetch(referral.inviteeDiscordId).catch(() => null),
        currentPlaytimeMinutes(referral, deps.playerStats)
      ]);
      names.set(referral.inviteeDiscordId, referredMember?.displayName ?? `<@${referral.inviteeDiscordId}>`);
      playtimes.set(referral.inviteeDiscordId, minutesPlayed);
    }
    const payload = referralsPage(interaction.user.id, data, names, playtimes, requestedPage, expiresAt);
    if (interaction.customId.startsWith("referrals:page:")) {
      await interaction.update(payload);
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  }
}

async function currentPlaytimeMinutes(referral: Referral, stats: PlayerStatsReader): Promise<number | null> {
  try {
    const eosId = referral.invitedEosId ?? await stats.findEosId(referral.inviteeDiscordId);
    return eosId ? await stats.getMinutesPlayed(eosId) : null;
  } catch {
    return null;
  }
}
