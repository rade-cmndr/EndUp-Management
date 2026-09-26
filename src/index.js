import { Client } from 'discord.js';
import {
  handleButtonInteraction,
  handleJoinCommand,
  handleLeaveCommand,
  handleMessageDeleteCommand,
  handleMessageUpdateCommand,
  handlePrefixCommandCustom,
  handleSelectMenuInteraction,
  handleSlashCommand,
  handleVoiceCommand,
  registerSlashCommands,
} from '../commands/index.js';

export function registerClientEvents(client) {
  client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
      await registerSlashCommands();
    } catch (error) {
      console.error('Slash command registration failed:', error.message);
    }
  });

  client.on('messageCreate', async (message) => {
    await handlePrefixCommandCustom(message);
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    }
  });

  client.on('guildMemberAdd', async (member) => {
    await handleJoinCommand(member);
  });

  client.on('guildMemberRemove', async (member) => {
    await handleLeaveCommand(member);
  });

  client.on('messageDelete', async (message) => {
    await handleMessageDeleteCommand(message);
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    await handleMessageUpdateCommand(oldMessage, newMessage);
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    await handleVoiceCommand(oldState, newState);
  });
}

export { Client };
