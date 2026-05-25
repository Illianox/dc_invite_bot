import { REST, Routes } from "discord.js";
import { env } from "../config/env.js";
import { commandDefinitions } from "../commands/definitions.js";

const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

void rest
  .put(Routes.applicationGuildCommands(env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID), {
    body: commandDefinitions
  })
  .then(() => console.log("Guild slash commands registered."))
  .catch((error) => {
    console.error("Command registration failed.", error);
    process.exitCode = 1;
  });
