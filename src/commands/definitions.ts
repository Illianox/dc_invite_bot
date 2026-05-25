import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

const adminPermission = PermissionFlagsBits.ManageGuild;
const rankingScopeOption = (command: any) =>
  command.addStringOption((option: any) =>
    option
      .setName("rangliste")
      .setDescription("Welche Rangliste angezeigt werden soll.")
      .setRequired(false)
      .addChoices(
        { name: "Monatlich", value: "monthly" },
        { name: "Gesamt", value: "all_time" }
      )
  );

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Verwaltet das Invite-Panel.")
    .setDefaultMemberPermissions(adminPermission)
    .addSubcommand((command) => command.setName("publish").setDescription("Veroeffentlicht oder aktualisiert das Invite-Panel.")),
  rankingScopeOption(
    new SlashCommandBuilder()
      .setName("rangliste")
      .setDescription("Veroeffentlicht oder aktualisiert das oeffentliche Ranking.")
      .setDefaultMemberPermissions(adminPermission)
  ),
  new SlashCommandBuilder()
    .setName("referral")
    .setDescription("Administriert Referral-Faelle.")
    .setDefaultMemberPermissions(adminPermission)
    .addSubcommand((command) => command.setName("list").setDescription("Zeigt offene und aktive Reward-Referrals."))
    .addSubcommand((command) =>
      command.setName("info").setDescription("Zeigt Reward-Details eines Mitglieds.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
    )
    .addSubcommand((command) =>
      command.setName("block").setDescription("Blockiert ein Reward-Referral.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
        .addStringOption((option) => option.setName("grund").setDescription("Grund").setRequired(true))
    )
    .addSubcommand((command) =>
      command.setName("unblock").setDescription("Entsperrt ein Reward-Referral.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
    )
    .addSubcommand((command) => command.setName("forcecheck").setDescription("Prueft alle aktiven Reward-Referrals sofort."))
    .addSubcommand((command) =>
      command.setName("forcereward").setDescription("Zahlt eine Reward-Etappe manuell aus.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
        .addStringOption((option) => option.setName("step_key").setDescription("Reward-Etappe").setRequired(true))
    )
    .addSubcommand((command) => command.setName("reload").setDescription("Laedt die Reward-Config neu."))
    .addSubcommand((command) =>
      command.setName("inspect").setDescription("Zeigt die Historie eines Mitglieds.")
        .addUserOption((option) => option.setName("member").setDescription("Mitglied").setRequired(true))
    )
    .addSubcommand((command) =>
      command.setName("assign").setDescription("Ordnet einen ungeklaerten Join manuell zu.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
        .addUserOption((option) => option.setName("inviter").setDescription("Werber").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Begruendung").setRequired(true))
    )
    .addSubcommand((command) =>
      command.setName("revoke").setDescription("Widerruft eine laufende Zuordnung.")
        .addUserOption((option) => option.setName("member").setDescription("Geworbenes Mitglied").setRequired(true))
        .addStringOption((option) => option.setName("reason").setDescription("Begruendung").setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName("system")
    .setDescription("Zeigt den technischen Botstatus.")
    .setDefaultMemberPermissions(adminPermission)
    .addSubcommand((command) => command.setName("status").setDescription("Zeigt Version, Datenbank- und Syncstatus."))
].map((command) => command.toJSON());
