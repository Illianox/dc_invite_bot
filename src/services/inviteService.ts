import { setTimeout as delay } from "node:timers/promises";
import { type Guild, type GuildMember, type Invite, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import type { Repository } from "../database/repositories/repository.js";
import type { UserInvite } from "../utils/domain.js";
import { resolveInviteChange } from "./inviteResolution.js";

export class InviteService {
  private activeInvites = new Map<string, UserInvite>();
  private snapshots = new Map<string, number>();
  private queues = new Map<string, Promise<void>>();
  private uncertainJoinBatch = new Set<string>();
  private recoveryRequired = new Set<string>();
  private lastSuccessfulSync: Date | null = null;

  public constructor(private readonly repository: Repository) {}

  public getLastSuccessfulSync(): Date | null {
    return this.lastSuccessfulSync;
  }

  public async establishBaseline(guild: Guild, reason: "startup" | "recovery" = "startup"): Promise<void> {
    const stored = await this.repository.listActiveInvites(guild.id);
    const fetched = await guild.invites.fetch();
    this.activeInvites.clear();

    for (const invite of stored) {
      if (!fetched.has(invite.inviteCode)) {
        await this.repository.markInviteDeleted(invite);
        continue;
      }
      this.activeInvites.set(invite.inviteCode, invite);
    }

    this.snapshots = this.useMap(fetched.values());
    await this.repository.saveSnapshots(this.snapshots, reason);
    this.lastSuccessfulSync = new Date();
  }

  public async getOrCreatePersonalInvite(guild: Guild, inviter: GuildMember): Promise<string> {
    const stored = await this.repository.findActiveInvite(guild.id, inviter.id);
    if (stored) {
      const fetched = await guild.invites.fetch();
      const live = fetched.get(stored.inviteCode);
      if (live) {
        this.activeInvites.set(stored.inviteCode, stored);
        this.snapshots.set(stored.inviteCode, live.uses ?? 0);
        return live.url;
      }
      await this.repository.markInviteDeleted(stored);
      this.activeInvites.delete(stored.inviteCode);
    }

    const channel = await guild.channels.fetch(env.INVITE_CHANNEL_ID);
    if (!(channel instanceof TextChannel)) {
      throw new Error("The configured invite channel must be a text channel.");
    }
    const invite = await channel.createInvite({
      maxAge: 0,
      maxUses: 0,
      unique: true,
      reason: `Persönlicher Spieler werben Spieler Einladungslink für ${inviter.user.tag}`
    });
    try {
      await this.repository.createInvite(guild.id, inviter.id, invite.code, channel.id, invite.uses ?? 0);
    } catch (error) {
      await invite.delete("Database save failed after personal invite creation.").catch(() => undefined);
      throw error;
    }
    const record = await this.repository.findActiveInvite(guild.id, inviter.id);
    if (record) this.activeInvites.set(invite.code, record);
    this.snapshots.set(invite.code, invite.uses ?? 0);
    return invite.url;
  }

  public enqueueMemberJoin(member: GuildMember): Promise<void> {
    const previous = this.queues.get(member.guild.id) ?? Promise.resolve();
    const current = previous
      .then(() => this.processMemberJoin(member))
      .catch(async (error: unknown) => {
        await this.repository.logError("join_processing_error", String(error));
      });
    this.queues.set(member.guild.id, current);
    void current.finally(() => {
      if (this.queues.get(member.guild.id) === current) {
        this.queues.delete(member.guild.id);
        this.uncertainJoinBatch.delete(member.guild.id);
      }
    });
    return current;
  }

  public queueSize(): number {
    return this.queues.size;
  }

  private async processMemberJoin(member: GuildMember): Promise<void> {
    const displayName = memberDisplayName(member);
    const queueId = await this.repository.enqueueJoin(member.guild.id, member.id, displayName, member.joinedAt ?? new Date());
    if (member.user.bot) {
      await this.repository.resolveQueuedJoin(queueId, {
        guildId: member.guild.id,
        inviterId: null,
        inviterName: null,
        inviteeId: member.id,
        inviteeName: displayName,
        inviteCode: null,
        joinedAt: member.joinedAt ?? new Date(),
        status: "non_referral",
        reason: "Bot-Accounts können keine Spielerwerbungen sein."
      }, this.snapshots);
      return;
    }

    if (this.uncertainJoinBatch.has(member.guild.id) || this.recoveryRequired.has(member.guild.id)) {
      const currentInvites = await member.guild.invites.fetch();
      const currentUses = this.useMap(currentInvites.values());
      await this.repository.resolveQueuedJoin(queueId, {
        guildId: member.guild.id,
        inviterId: null,
        inviterName: null,
        inviteeId: member.id,
        inviteeName: displayName,
        inviteCode: null,
        joinedAt: member.joinedAt ?? new Date(),
        status: "unresolved",
        reason: this.recoveryRequired.has(member.guild.id)
          ? "Ein vorheriger Discord-API-Fehler erfordert eine neue Invite-Basis."
          : "Der Beitritt lag in einer bereits uneindeutigen Verarbeitungsgruppe."
      }, currentUses);
      this.snapshots = currentUses;
      this.recoveryRequired.delete(member.guild.id);
      return;
    }

    const backoff = [1_000, 3_000, 10_000];
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      try {
        const currentInvites = await member.guild.invites.fetch();
        const currentUses = this.useMap(currentInvites.values());
        const resolution = resolveInviteChange(this.snapshots, currentUses, new Set(this.activeInvites.keys()));
        const inviteCode = resolution.kind === "pending" ? resolution.inviteCode : null;
        const managed = inviteCode ? this.activeInvites.get(inviteCode) : null;
        const inviterName = managed ? await this.findMemberName(member.guild, managed.inviterDiscordId) : null;
        const resolvedSnapshots = resolution.kind === "pending" ? resolution.consumedUses : currentUses;

        if (resolution.kind === "pending" && resolution.delta > 1 && attempt === 0) {
          const retryAt = new Date(Date.now() + backoff[attempt]!);
          await this.repository.setQueueAttempt(queueId, attempt + 1, retryAt, "Mehrere neue Invite-Nutzungen erkannt, kurze Gegenprüfung folgt.");
          await delay(backoff[attempt]!);
          continue;
        }

        if (resolution.kind === "unresolved" && resolution.reason.startsWith("Kein verwalteter Einladungslink") && attempt < backoff.length) {
          const retryAt = new Date(Date.now() + backoff[attempt]!);
          await this.repository.setQueueAttempt(queueId, attempt + 1, retryAt, "Invite-Nutzungsstand noch unverändert, erneute Prüfung folgt.");
          await delay(backoff[attempt]!);
          continue;
        }

        if (managed?.inviterDiscordId === member.id) {
          await this.repository.resolveQueuedJoin(queueId, {
            guildId: member.guild.id,
            inviterId: null,
            inviterName: null,
            inviteeId: member.id,
            inviteeName: displayName,
            inviteCode,
            joinedAt: member.joinedAt ?? new Date(),
            status: "non_referral",
            reason: "Selbsteinladungen sind nicht erlaubt."
          }, resolvedSnapshots);
        } else {
          if (resolution.kind === "unresolved") this.uncertainJoinBatch.add(member.guild.id);
          if (resolution.kind === "pending" && managed) await this.sendWelcomeMessage(member, managed.inviterDiscordId);
          await this.repository.resolveQueuedJoin(queueId, {
            guildId: member.guild.id,
            inviterId: managed?.inviterDiscordId ?? null,
            inviterName,
            inviteeId: member.id,
            inviteeName: displayName,
            inviteCode,
            joinedAt: member.joinedAt ?? new Date(),
            status: resolution.kind,
            reason: resolution.kind === "pending" ? "Eindeutige Nutzung eines verwalteten Einladungslinks erkannt." : resolution.kind === "non_referral" ? "Keine Nutzung eines verwalteten Einladungslinks erkannt." : resolution.reason
          }, resolvedSnapshots);
        }
        this.snapshots = resolvedSnapshots;
        this.lastSuccessfulSync = new Date();
        return;
      } catch (error) {
        if (attempt === backoff.length) {
          this.recoveryRequired.add(member.guild.id);
          await this.repository.resolveQueuedJoin(queueId, {
            guildId: member.guild.id,
            inviterId: null,
            inviterName: null,
            inviteeId: member.id,
            inviteeName: displayName,
            inviteCode: null,
            joinedAt: member.joinedAt ?? new Date(),
            status: "unresolved",
            reason: `Discord-Invite-Abfrage nach mehreren Versuchen fehlgeschlagen: ${String(error)}`
          }, this.snapshots);
          return;
        }
        const retryAt = new Date(Date.now() + backoff[attempt]!);
        await this.repository.setQueueAttempt(queueId, attempt + 1, retryAt, String(error));
        await delay(backoff[attempt]!);
      }
    }
  }

  private useMap(invites: Iterable<Invite>): Map<string, number> {
    return new Map(Array.from(invites, (invite) => [invite.code, invite.uses ?? 0]));
  }

  private async findMemberName(guild: Guild, memberId: string): Promise<string | null> {
    const member = await guild.members.fetch(memberId).catch(() => null);
    return member ? memberDisplayName(member) : null;
  }

  private async sendWelcomeMessage(member: GuildMember, inviterId: string): Promise<void> {
    if (!env.WELCOME_MESSAGE_ENABLED) return;
    const channel = await member.guild.channels.fetch(env.WELCOME_CHANNEL_ID).catch(() => null);
    if (!(channel instanceof TextChannel)) {
      await this.repository.logError("welcome_message_error", "Der konfigurierte Welcome-Channel ist kein Textchannel oder konnte nicht gefunden werden.");
      return;
    }
    await channel.send({
      content: [
        `Willkommen ${member} auf dem Server!`,
        "",
        `Du wurdest von <@${inviterId}> eingeladen.`,
        `Danke an <@${inviterId}> fürs Einladen!`
      ].join("\n")
    }).catch((error: unknown) => this.repository.logError("welcome_message_error", String(error)));
  }
}

function memberDisplayName(member: GuildMember): string {
  return member.displayName && member.displayName !== member.user.username
    ? `${member.displayName} (${member.user.tag})`
    : member.user.tag;
}
