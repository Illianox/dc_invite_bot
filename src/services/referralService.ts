import type { Guild, GuildMember } from "discord.js";
import { env } from "../config/env.js";
import type { Repository } from "../database/repositories/repository.js";
import type { Referral } from "../utils/domain.js";

export type RankingScope = "monthly" | "all_time";
export type MemberEvaluationResult = "unchanged" | "qualified" | "unqualified";

export class ReferralService {
  public constructor(private readonly repository: Repository) {}

  public isLinked(member: GuildMember): boolean {
    return member.roles.cache.has(env.LINKED_ROLE_ID);
  }

  public isQualified(member: GuildMember): boolean {
    return !member.user.bot && !member.pending && this.isLinked(member);
  }

  public async evaluateMember(member: GuildMember): Promise<MemberEvaluationResult> {
    const referral = await this.repository.findCurrentReferral(member.guild.id, member.id);
    if (!referral || referral.status === "pending" && !this.isQualified(member)) return "unchanged";

    if (this.isQualified(member) && referral.status !== "qualified") {
      await this.repository.transitionReferral(referral, "qualified", "referral_qualified", null, "Mitglied ist verknuepft und das Screening ist abgeschlossen.");
      return "qualified";
    }
    if (!this.isLinked(member) && referral.status === "qualified") {
      await this.repository.transitionReferral(referral, "unqualified", "referral_unqualified", null, "Mitglied hat die Linked-Rolle verloren.");
      return "unqualified";
    }
    return "unchanged";
  }

  public async memberLeft(member: GuildMember): Promise<void> {
    const referral = await this.repository.findCurrentReferral(member.guild.id, member.id);
    if (referral) {
      await this.repository.transitionReferral(referral, "left", "referral_left", null, "Mitglied hat den Server verlassen.");
    }
  }

  public async listForInviter(guildId: string, inviterId: string): Promise<Referral[]> {
    return this.repository.listQualifiedByInviter(guildId, inviterId);
  }

  public async activeRanking(guild: Guild, scope: RankingScope): Promise<Array<{ member: GuildMember; total: number }>> {
    const period = scope === "monthly" ? currentMonthPeriod() : null;
    const raw = await this.repository.getRanking(guild.id, period, env.RANKING_DISPLAY_LIMIT);
    const results: Array<{ member: GuildMember; total: number }> = [];
    for (const row of raw) {
      const member = await guild.members.fetch(row.inviterId).catch(() => null);
      if (member && !member.user.bot && this.isLinked(member)) results.push({ member, total: row.total });
      if (results.length === env.RANKING_DISPLAY_LIMIT) break;
    }
    return results;
  }

  public async syncRunning(guild: Guild): Promise<void> {
    for (const referral of await this.repository.listRunningReferrals(guild.id)) {
      const member = await guild.members.fetch(referral.inviteeDiscordId).catch(() => null);
      if (member) await this.evaluateMember(member);
    }
  }
}

function currentMonthPeriod(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1)
  };
}
