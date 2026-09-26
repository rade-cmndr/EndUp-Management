import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { registerClientEvents } from './index.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
});

registerClientEvents(client);

client.login(config.token).catch((error) => {
  console.error('Failed to login:', error.message);
  process.exit(1);
});

export { client };
