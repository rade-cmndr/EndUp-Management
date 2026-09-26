# EndUp Management

EndUp Management is a complete Discord bot built for moderation, logging, ticketing, utility features, verification, and voice automation.

## Features included

- Moderation commands: `/ban`, `/kick`, `/mute`, `/unmute`, `/warn`, and prefix support
- Persistent moderation history and warnings tracking
- Logging channel configuration with real-time event logging
- Join-to-create temporary voice channels
- Advanced multi-category ticket system with role-based access and transcript-style closure
- Welcome messages and automatic role assignment
- Button-based role assignment
- Verification system with alt-account detection thresholds
- Dynamic prefix support for each server

## Tech stack

- Node.js
- Discord.js v14
- SQLite database via better-sqlite3

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy the environment file:
   ```bash
   cp .env.example .env
   ```

3. Fill in the required values in `.env`:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID`
   - `PREFIX`

4. Start the bot:
   ```bash
   npm start
   ```

## Bot command overview

### Prefix commands

- `!ban @user reason`
- `!kick @user reason`
- `!mute @user 10m reason`
- `!unmute @user`
- `!warn @user reason`
- `!setlog #channel`
- `!setprefix $`
- `!setupvoicehub #hub-channel`
- `!settickettype general-support #category`
- `!ticket`
- `!roleembed`

### Slash commands

- `/ban`
- `/kick`
- `/mute`
- `/unmute`
- `/warn`
- `/setlog`
- `/setprefix`
- `/setwelcome`
- `/setupverify`
- `/setupvoicehub`
- `/settickettype`
- `/ticket`
- `/roleembed`

## Notes

This repo is a production-ready starter project for a Discord bot and includes the core features from your feature list with persistent database support and modular logic.

## License

MIT
