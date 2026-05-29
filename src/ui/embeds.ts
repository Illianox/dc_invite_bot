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
  if (env.PANEL_IMAGE_URL) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x8f0d18)
          .setImage(env.PANEL_IMAGE_URL)
      ],
      components: mainPanelButtons()
    };
  }

  const embed = new EmbedBuilder()
    .setColor(0x8f0d18)
    .setTitle("Blacklist Spieler werben Spieler")
    .setDescription(
      [
        "**1. Verknuepfen**",
        "Verknuepfe deinen Discord-Account ueber das bestehende Blacklist-Link-System.",
        "",
        "**2. Einladungslink abrufen**",
        "Sobald du die Rolle **Linked** besitzt, kannst du deinen persoenlichen Einladungslink abrufen.",
        "",
        "**3. Spieler werben**",
        "Erfolgreiche Einladungen zaehlen, sobald das neue Mitglied ebenfalls **Linked** ist.",
        "",
        "**4. Fortschritt pruefen**",
        "Ueber **Meine geworbenen Spieler** siehst du deine erfolgreichen Spielerwerbungen privat."
      ].join("\n")
    )
    .setFooter({ text: "Spieler werben Spieler | Blacklist" });
  if (env.PANEL_BANNER_URL) embed.setImage(env.PANEL_BANNER_URL);
  if (env.PANEL_THUMBNAIL_URL) embed.setThumbnail(env.PANEL_THUMBNAIL_URL);

  return {
    embeds: [embed],
    components: mainPanelButtons()
  };
}

function mainPanelButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("invite:mine").setLabel("Mein Einladungslink").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("referrals:mine:0").setLabel("Meine geworbenen Spieler").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rewards:claim").setLabel("Belohnung abholen").setStyle(ButtonStyle.Secondary)
    )
  ];
}

export function referralsPage(
  requesterId: string,
  referrals: Referral[],
  names: Map<string, string>,
  earnedPlaytimes: Map<string, number | null>,
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
          const playtime = formatPlaytime(earnedPlaytimes.get(referral.inviteeDiscordId) ?? null);
          return `**${position}.** ${name} - <t:${Math.floor(referral.joinedAt.getTime() / 1000)}:d> - Seit Aktivierung: **${playtime}**`;
        })
        .join("\n")
    : "Du hast aktuell keine erfolgreichen Spielerwerbungen.";

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Meine geworbenen Spieler")
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

function formatPlaytime(minutes: number | null): string {
  if (minutes === null) return "unbekannt";
  const safeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remaining = safeMinutes % 60;
  return remaining > 0 ? `${hours} Std. ${remaining} Min.` : `${hours} Std.`;
}

export function rankingEmbed(rows: Array<{ member: GuildMember; total: number }>, scope: RankingScope): EmbedBuilder {
  const scopeLabel = scope === "monthly" ? "Monatlich" : "Gesamt";
  const footer = scope === "monthly"
    ? "Nur erfolgreiche Spielerwerbungen des aktuellen Monats werden gezaehlt."
    : "Nur erfolgreiche Spielerwerbungen der gesamten Laufzeit werden gezaehlt.";
  return new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle(`Blacklist Spieler werben Spieler System | ${scopeLabel} | Top ${env.RANKING_DISPLAY_LIMIT}`)
    .setDescription(
      rows.length
        ? rows.map((row, index) => `**${index + 1}.** ${row.member.displayName} - **${row.total}**`).join("\n")
        : "Es gibt aktuell keine erfolgreichen Spielerwerbungen."
    )
    .setFooter({ text: footer })
    .setTimestamp();
}
