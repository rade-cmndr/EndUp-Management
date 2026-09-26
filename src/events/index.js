import { GatewayIntentBits, Partials } from 'discord.js';
import { Client } from 'discord.js';
import { config } from '../config.js';
import { registerSlashCommands, handleSlashCommand, handlePrefixCommand, handleButtonInteraction, handleSelectMenuInteraction, handleVoiceEvents, handleJoinEvent, handleLeaveEvent, handleMessageDelete, handleMessageUpdate } from './index.js';

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
    await handlePrefixCommand(message);
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
    await handleJoinEvent(member);
  });

  client.on('guildMemberRemove', async (member) => {
    await handleLeaveEvent(member);
  });

  client.on('messageDelete', async (message) => {
    await handleMessageDelete(message);
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    await handleMessageUpdate(oldMessage, newMessage);
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    await handleVoiceEvents(oldState, newState);
  });
}

export { Client };
