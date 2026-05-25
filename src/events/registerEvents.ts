import { Events, type Client, type GuildMember, MessageFlags } from "discord.js";
import { env } from "../config/env.js";
import type { CommandDependencies } from "../commands/handlers.js";
import { handleButton, handleCommand } from "../commands/handlers.js";

export function registerEvents(client: Client, deps: CommandDependencies): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, deps);
      } else if (interaction.isButton()) {
        await handleButton(interaction, deps);
      }
    } catch (error) {
      await deps.repository.logError("interaction_error", String(error)).catch(() => undefined);
      const response = { content: "Die Aktion konnte nicht verarbeitet werden. Das Team wurde informiert.", flags: MessageFlags.Ephemeral as const };
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => undefined);
        else await interaction.reply(response).catch(() => undefined);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== env.DISCORD_GUILD_ID) return;
    await deps.invites.enqueueMemberJoin(member);
    await deps.referrals.evaluateMember(member).catch((error: unknown) => deps.repository.logError("join_qualification_error", String(error)));
  });

  client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
    if (newMember.guild.id !== env.DISCORD_GUILD_ID) return;
    await deps.referrals.evaluateMember(newMember).catch((error: unknown) => deps.repository.logError("member_update_error", String(error)));
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== env.DISCORD_GUILD_ID) return;
    await deps.referrals.memberLeft(member as GuildMember).catch((error: unknown) => deps.repository.logError("member_remove_error", String(error)));
  });
}
