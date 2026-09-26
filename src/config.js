import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const requiredEnv = ['DISCORD_TOKEN'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`Warning: ${key} is not defined in .env`);
  }
}

export const config = {
  token: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  guildId: process.env.GUILD_ID || '',
  prefix: process.env.PREFIX || '!',
  dataDir: path.resolve(process.cwd(), 'data'),
};

if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}
