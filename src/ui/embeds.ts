import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type GuildMember
} from "discord.js";
import { env } from "../config/env.js";
import type { RankingScope } from "../services/referralService.js";
import type { Referral } from "../utils/domain.js";

export function mainPanel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(0x241722)
    .setTitle("Blacklist Invite-System")
    .setDescription(
      [
        "1. Verknuepfe deinen Discord-Account ueber das bestehende Blacklist-Link-System.",
        "",
        "2. Sobald du die Rolle **Linked** besitzt, kannst du deinen persoenlichen Einladungslink abrufen.",
        "",
        "3. Erfolgreiche Einladungen zaehlen, sobald das neue Mitglied ebenfalls **Linked** ist.",
        "",
        "4. Ueber **Meine Einladungen** siehst du deine gueltigen Referrals privat."
      ].join("\n")
    )
    .setFooter({ text: "Invite Panel | Blacklist" });
  if (env.PANEL_THUMBNAIL_URL) embed.setThumbnail(env.PANEL_THUMBNAIL_URL);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("invite:mine").setLabel("Mein Invite-Link").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("referrals:mine:0").setLabel("Meine Einladungen").setStyle(ButtonStyle.Primary)
      )
    ]
  };
}

export function referralsPage(
  requesterId: string,
  referrals: Referral[],
  names: Map<string, string>,
  page: number,
  expiresAt: number
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const pageSize = 8;
  const lastPage = Math.max(0, Math.ceil(referrals.length / pageSize) - 1);
  const safePage = Math.max(0, Math.min(page, lastPage));
  const pageItems = referrals.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const description = pageItems.length
    ? pageItems
        .map((referral, index) => {
          const position = safePage * pageSize + index + 1;
          const name = names.get(referral.inviteeDiscordId) ?? `<@${referral.inviteeDiscordId}>`;
          return `**${position}.** ${name} - <t:${Math.floor(referral.joinedAt.getTime() / 1000)}:d>`;
        })
        .join("\n")
    : "Du hast aktuell keine qualifizierten Einladungen.";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Meine Einladungen")
    .setDescription(description)
    .setFooter({ text: `Gesamt: ${referrals.length} | Seite ${safePage + 1}/${lastPage + 1}` });
  const components = lastPage > 0
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`referrals:page:${requesterId}:${safePage - 1}:${expiresAt}`).setLabel("Zurueck").setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
          new ButtonBuilder().setCustomId(`referrals:page:${requesterId}:${safePage + 1}:${expiresAt}`).setLabel("Weiter").setStyle(ButtonStyle.Secondary).setDisabled(safePage === lastPage)
        )
      ]
    : [];
  return { embeds: [embed], components };
}

export function rankingEmbed(rows: Array<{ member: GuildMember; total: number }>, scope: RankingScope): EmbedBuilder {
  const scopeLabel = scope === "monthly" ? "Monatlich" : "Gesamt";
  const footer = scope === "monthly"
    ? "Nur aktive Linked-Referrals des aktuellen Monats werden gezaehlt."
    : "Nur aktive Linked-Referrals der gesamten Laufzeit werden gezaehlt.";
  return new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle(`Blacklist Invite-System | ${scopeLabel} | Top ${env.RANKING_DISPLAY_LIMIT}`)
    .setDescription(
      rows.length
        ? rows.map((row, index) => `**${index + 1}.** ${row.member.displayName} - **${row.total}**`).join("\n")
        : "Es gibt aktuell keine qualifizierten Einladungen."
    )
    .setFooter({ text: footer })
    .setTimestamp();
}
