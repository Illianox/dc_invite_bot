import { PermissionFlagsBits, TextChannel, type Guild } from "discord.js";
import { env } from "../config/env.js";

export async function validateDiscordSetup(guild: Guild): Promise<void> {
  const botMember = guild.members.me ?? await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error("The bot requires Manage Guild to read invite use counts.");
  }

  const channels = [
    { id: env.INVITE_CHANNEL_ID, name: "invite", permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.CreateInstantInvite] },
    { id: env.PANEL_CHANNEL_ID, name: "panel", permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    { id: env.RANKING_CHANNEL_ID, name: "ranking", permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    { id: env.WELCOME_CHANNEL_ID, name: "welcome", permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
    { id: env.ADMIN_LOG_CHANNEL_ID, name: "admin log", permissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
  ];

  for (const expected of channels) {
    const channel = await guild.channels.fetch(expected.id);
    if (!(channel instanceof TextChannel)) {
      throw new Error(`Configured ${expected.name} channel must be a guild text channel.`);
    }
    const permissions = channel.permissionsFor(botMember);
    for (const permission of expected.permissions) {
      if (!permissions?.has(permission)) {
        throw new Error(`Bot lacks a required permission in the configured ${expected.name} channel.`);
      }
    }
  }

  const linkedRole = await guild.roles.fetch(env.LINKED_ROLE_ID).catch(() => null);
  if (!linkedRole) {
    throw new Error("The configured Linked role does not exist in the guild.");
  }
}
