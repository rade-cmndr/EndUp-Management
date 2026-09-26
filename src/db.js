import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
  Routes,
  REST,
  DiscordAPIError,
} from 'discord.js';

import { config } from './config.js';
import db, {
  ensureGuildSettings,
  getGuildPrefix,
  setGuildPrefix,
  addModerationRecord,
  addWarning,
  getWarnings,
  setMute,
  clearMute,
  getMute,
  addTicketType,
  getTicketTypesByGuild,
  addTempVoiceChannel,
  removeTempVoiceChannel,
  isTempVoiceChannel,
  addRoleButton,
  getRoleButtonData,
  setGuildSetting,
} from './db.js';

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

const commandMap = new Map();

function createEmbed(title, description, color = 0x5865f2) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}

function getLogChannel(guild) {
  const channelId = db.prepare('SELECT log_channel_id FROM guild_settings WHERE guild_id = ?').get(guild.id)?.log_channel_id;
  return channelId ? guild.channels.cache.get(channelId) : null;
}

async function logEvent(guild, title, description, color = 0x5865f2) {
  const channel = getLogChannel(guild);
  if (!channel) return;
  try {
    await channel.send({ embeds: [createEmbed(title, description, color)] });
  } catch (error) {
    console.error(`Failed to send log to ${guild.id}:`, error.message);
  }
}

function parseTimeToMs(raw) {
  if (!raw) return null;
  const match = raw.match(/^((?:\d+)(?:[smhdw]))+$/i);
  if (!match) return null;

  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  let total = 0;
  const regex = /(\d+)([smhdw])/gi;
  let part;
  while ((part = regex.exec(raw))) {
    total += Number(part[1]) * units[part[2].toLowerCase()];
  }
  return total;
}

function durationDisplay(ms) {
  if (!ms || ms <= 0) return '0s';
  const parts = [];
  const units = [
    { label: 'w', value: 7 * 24 * 60 * 60 * 1000 },
    { label: 'd', value: 24 * 60 * 60 * 1000 },
    { label: 'h', value: 60 * 60 * 1000 },
    { label: 'm', value: 60 * 1000 },
    { label: 's', value: 1000 },
  ];

  for (const unit of units) {
    const amount = Math.floor(ms / unit.value);
    if (amount > 0) {
      parts.push(`${amount}${unit.label}`);
      ms -= amount * unit.value;
    }
  }
  return parts.join(' ') || '0s';
}

async function getGuildMember(guild, target) {
  if (target instanceof Object && target.id) return target;
  return guild.members.fetch(target).catch(() => null);
}

function ensureGuildRecord(guildId) {
  return ensureGuildSettings(guildId);
}

async function createTicketChannel(guild, user, ticketTypeName, categoryId) {
  const safeName = `${ticketTypeName.toLowerCase().replace(/[^a-z0-9- ]/g, '').replace(/\s+/g, '-')}-${user.username}`;
  const category = guild.channels.cache.get(categoryId) ?? null;

  const channel = await guild.channels.create({
    name: `ticket-${safeName}`.slice(0, 80),
    type: ChannelType.GuildText,
    parent: category ? category.id : null,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
    ],
  });

  const staffRoleIds = guild.roles.cache.filter((role) => role.permissions.has(PermissionFlagsBits.ManageGuild) || role.permissions.has(PermissionFlagsBits.ModerateMembers)).map((role) => role.id);
  for (const roleId of staffRoleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => {});
  }

  const closeButton = new ButtonBuilder().setCustomId(`close_ticket:${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger);
  const lockButton = new ButtonBuilder().setCustomId(`lock_ticket:${channel.id}`).setLabel('Lock').setStyle(ButtonStyle.Secondary);
  const addUserButton = new ButtonBuilder().setCustomId(`add_user_ticket:${channel.id}`).setLabel('Add User').setStyle(ButtonStyle.Primary);

  await channel.send({
    embeds: [
      createEmbed(
        `Ticket: ${ticketTypeName}`,
        `Support has been requested by ${user}.
        Please describe your issue and a staff member will assist shortly.`,
        0x00b894,
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(closeButton, lockButton, addUserButton),
    ],
  });

  return channel;
}

async function handleTicketInteraction(interaction) {
  const { customId } = interaction;
  if (customId.startsWith('close_ticket:')) {
    const channelId = customId.split(':')[1];
    const channel = interaction.guild.channels.cache.get(channelId);
    if (channel) {
      await channel.send({ embeds: [createEmbed('Ticket Closed', `This ticket was closed by ${interaction.user.username}.`, 0xe74c3c)] });
      await channel.delete(`Closed by ${interaction.user.id}`).catch(() => {});
    }
    await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
    return;
  }

  if (customId.startsWith('lock_ticket:')) {
    const channelId = customId.split(':')[1];
    const channel = interaction.guild.channels.cache.get(channelId);
    if (channel) {
      const current = channel.permissionOverwrites.cache.get(interaction.guild.id);
      await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false, ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
      await interaction.reply({ content: `Ticket locked: ${channel}.`, ephemeral: true });
    }
    return;
  }

  if (customId.startsWith('add_user_ticket:')) {
    const channelId = customId.split(':')[1];
    const channel = interaction.guild.channels.cache.get(channelId);
    if (channel) {
      const prompt = await interaction.reply({ content: 'Mention a user to add to the ticket.', fetchReply: true, ephemeral: true });
      const collected = await interaction.channel.awaitMessages({ filter: (msg) => msg.author.id === interaction.user.id, max: 1, time: 30000 });
      const match = collected.first()?.mentions.members?.first();
      if (match) {
        await channel.permissionOverwrites.edit(match.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        await interaction.followUp({ content: `${match} has been added to the ticket.`, ephemeral: true });
      }
    }
    return;
  }
}

async function handleButtonInteraction(interaction) {
  const [type, ...rest] = interaction.customId.split(':');

  if (type === 'role') {
    const roleId = rest.join(':');
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.reply({ content: 'That role no longer exists.', ephemeral: true });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId);
      await interaction.reply({ content: `Removed the ${role.name} role.`, ephemeral: true });
    } else {
      await member.roles.add(roleId);
      await interaction.reply({ content: `Added the ${role.name} role.`, ephemeral: true });
    }
    return;
  }

  if (type === 'verify') {
    const member = interaction.guild.members.cache.get(interaction.user.id) || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return;

    const settings = ensureGuildRecord(interaction.guild.id);
    const verifyRole = settings.verify_role_id ? interaction.guild.roles.cache.get(settings.verify_role_id) : null;
    if (!verifyRole) {
      await interaction.reply({ content: 'The verification role is not configured yet.', ephemeral: true });
      return;
    }

    const thresholdDays = settings.alt_min_days || 7;
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const isAltAccount = accountAgeMs < thresholdDays * 24 * 60 * 60 * 1000;

    if (isAltAccount && settings.alt_check_enabled) {
      await member.kick('Alt account detected during verification.');
      await interaction.reply({ content: 'Your account is too new to join this server. Please contact staff.', ephemeral: true });
      return;
    }

    await member.roles.add(verifyRole);
    await interaction.reply({ content: `You are now verified in ${interaction.guild.name}.`, ephemeral: true });
    return;
  }

  if (type === 'ticket') {
    const ticketType = rest.join(':');
    const types = getTicketTypesByGuild(interaction.guild.id);
    const selectedType = types.find((item) => item.name === ticketType);
    if (!selectedType) {
      await interaction.reply({ content: 'That ticket type is not configured.', ephemeral: true });
      return;
    }

    const channel = await createTicketChannel(interaction.guild, interaction.user, selectedType.name, selectedType.category_id);
    await interaction.reply({ content: `Your ticket has been created: ${channel}`, ephemeral: true });
    return;
  }

  if (customId.startsWith('close_ticket:') || customId.startsWith('lock_ticket:') || customId.startsWith('add_user_ticket:')) {
    await handleTicketInteraction(interaction);
    return;
  }
}

async function handleSelectMenuInteraction(interaction) {
  if (interaction.customId !== 'ticket_select') return;

  const selected = interaction.values[0];
  const row = getTicketTypesByGuild(interaction.guild.id).find((entry) => entry.name.toLowerCase() === selected.toLowerCase());
  if (!row) {
    await interaction.reply({ content: 'The selected ticket type is missing.', ephemeral: true });
    return;
  }

  const channel = await createTicketChannel(interaction.guild, interaction.user, row.name, row.category_id);
  await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
}

async function registerSlashCommands() {
  if (!config.clientId) {
    console.warn('CLIENT_ID is not set. Slash commands will not register.');
    return;
  }

  const commands = [
    { name: 'ban', description: 'Ban a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'kick', description: 'Kick a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'mute', description: 'Mute a member for a duration.', options: [{ name: 'user', type: 6, required: true }, { name: 'duration', type: 3, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'unmute', description: 'Remove a mute from a member.', options: [{ name: 'user', type: 6, required: true }] },
    { name: 'warn', description: 'Warn a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: true }] },
    { name: 'setlog', description: 'Set the log channel.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }] },
    { name: 'setprefix', description: 'Set the server prefix.', options: [{ name: 'prefix', type: 3, required: true }] },
    { name: 'setwelcome', description: 'Set welcome settings.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }, { name: 'role', type: 8, required: false }, { name: 'message', type: 3, required: false }] },
    { name: 'setupverify', description: 'Set the verification channel and role.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }, { name: 'role', type: 8, required: true }, { name: 'min_days', type: 4, required: false }] },
    { name: 'setupvoicehub', description: 'Set the voice hub channel.', options: [{ name: 'channel', type: 7, required: true, channel_types: [2] }] },
    { name: 'settickettype', description: 'Create a ticket type with a category.', options: [{ name: 'name', type: 3, required: true }, { name: 'category', type: 7, required: true, channel_types: [4] }] },
    { name: 'ticket', description: 'Open the ticket menu.', options: [] },
    { name: 'roleembed', description: 'Create a button role embed.', options: [{ name: 'title', type: 3, required: true }, { name: 'description', type: 3, required: true }, { name: 'role', type: 8, required: true }, { name: 'label', type: 3, required: true }] },
  ];

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId || '@me'), { body: commands });
  console.log('Slash commands registered successfully.');
}

async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, options } = interaction;

  if (commandName === 'ban') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason provided';
    if (!target) {
      await interaction.reply({ content: 'I could not find that user.', ephemeral: true });
      return;
    }
    await guild.members.ban(target.id, { reason });
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: member.id, action: 'ban', reason });
    await interaction.reply({ embeds: [createEmbed('User Banned', `${target} has been banned. Reason: ${reason}`, 0xe74c3c)] });
    await logEvent(guild, 'Ban', `${target} was banned by ${member}. Reason: ${reason}`, 0xe74c3c);
    return;
  }

  if (commandName === 'kick') {
    const target = options.getMember('user');
    const reason = options.getString('reason') || 'No reason provided';
    if (!target) {
      await interaction.reply({ content: 'I could not find that user.', ephemeral: true });
      return;
    }
    await target.kick(reason);
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: member.id, action: 'kick', reason });
    await interaction.reply({ embeds: [createEmbed('User Kicked', `${target} was kicked. Reason: ${reason}`, 0xf39c12)] });
    await logEvent(guild, 'Kick', `${target} was kicked by ${member}. Reason: ${reason}`, 0xf39c12);
    return;
  }

  if (commandName === 'mute') {
    const target = options.getMember('user');
    const duration = options.getString('duration');
    const reason = options.getString('reason') || 'No reason provided';
    const ms = parseTimeToMs(duration);
    if (!target || !ms) {
      await interaction.reply({ content: 'Provide a valid user and duration like `10m`, `1h`, or `2d`.', ephemeral: true });
      return;
    }

    await target.timeout(ms, reason);
    setMute(guild.id, target.id, Date.now() + ms, reason);
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: member.id, action: 'mute', reason });
    await interaction.reply({ embeds: [createEmbed('User Muted', `${target} was muted for ${duration}.`, 0x9b59b6)] });
    await logEvent(guild, 'Mute', `${target} was muted by ${member} for ${duration}. Reason: ${reason}`, 0x9b59b6);
    return;
  }

  if (commandName === 'unmute') {
    const target = options.getMember('user');
    if (!target) {
      await interaction.reply({ content: 'I could not find that user.', ephemeral: true });
      return;
    }
    await target.timeout(null).catch(() => {});
    clearMute(guild.id, target.id);
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: member.id, action: 'unmute', reason: 'Removed mute' });
    await interaction.reply({ embeds: [createEmbed('User Unmuted', `${target} has been unmuted.`, 0x2ecc71)] });
    await logEvent(guild, 'Unmute', `${target} was unmuted by ${member}.`, 0x2ecc71);
    return;
  }

  if (commandName === 'warn') {
    const target = options.getMember('user');
    const reason = options.getString('reason');
    if (!target) {
      await interaction.reply({ content: 'I could not find that user.', ephemeral: true });
      return;
    }
    addWarning({ guildId: guild.id, userId: target.id, moderatorId: member.id, reason });
    const warnings = getWarnings(guild.id, target.id).length;
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: member.id, action: 'warn', reason });
    await interaction.reply({ embeds: [createEmbed('User Warned', `${target} has been warned. Total warnings: ${warnings}. Reason: ${reason}`, 0xf1c40f)] });
    await logEvent(guild, 'Warning', `${target} was warned by ${member}. Reason: ${reason}`, 0xf1c40f);
    return;
  }

  if (commandName === 'setlog') {
    const channel = options.getChannel('channel');
    setGuildSetting(guild.id, 'log_channel_id', channel.id);
    await interaction.reply({ embeds: [createEmbed('Logging Channel Set', `Logs will now be sent to ${channel}.`, 0x5865f2)] });
    return;
  }

  if (commandName === 'setprefix') {
    const prefix = options.getString('prefix');
    setGuildPrefix(guild.id, prefix);
    await interaction.reply({ embeds: [createEmbed('Prefix Updated', `This server prefix is now ${prefix}.`, 0x5865f2)] });
    return;
  }

  if (commandName === 'setwelcome') {
    const channel = options.getChannel('channel');
    const role = options.getRole('role');
    const message = options.getString('message') || 'Welcome {user} to {guild}! We are glad to have you here!';
    setGuildSetting(guild.id, 'welcome_channel_id', channel.id);
    if (role) setGuildSetting(guild.id, 'auto_role_id', role.id);
    setGuildSetting(guild.id, 'welcome_message', message);
    await interaction.reply({ embeds: [createEmbed('Welcome Settings Updated', `Welcome channel: ${channel}. Auto-role: ${role || 'None'}.`, 0x00b894)] });
    return;
  }

  if (commandName === 'setupverify') {
    const channel = options.getChannel('channel');
    const role = options.getRole('role');
    const minDays = options.getInteger('min_days') ?? 7;
    setGuildSetting(guild.id, 'verify_channel_id', channel.id);
    setGuildSetting(guild.id, 'verify_role_id', role.id);
    setGuildSetting(guild.id, 'alt_min_days', minDays);
    setGuildSetting(guild.id, 'alt_check_enabled', 1);

    await interaction.reply({ embeds: [createEmbed('Verification Setup', `Verify channel set to ${channel}. Role: ${role}. Min account age: ${minDays} days.`, 0x00b894)] });
    return;
  }

  if (commandName === 'setupvoicehub') {
    const channel = options.getChannel('channel');
    setGuildSetting(guild.id, 'voice_hub_channel_id', channel.id);
    await interaction.reply({ embeds: [createEmbed('Voice Hub Set', `${channel} is now the join-to-create hub.`, 0x1abc9c)] });
    return;
  }

  if (commandName === 'settickettype') {
    const name = options.getString('name');
    const category = options.getChannel('category');
    addTicketType(guild.id, name, category.id);
    await interaction.reply({ embeds: [createEmbed('Ticket Type Created', `Ticket type ${name} uses category ${category}.`, 0x3498db)] });
    return;
  }

  if (commandName === 'ticket') {
    const types = getTicketTypesByGuild(guild.id);
    if (!types.length) {
      await interaction.reply({ content: 'No ticket types are configured yet. Use `/settickettype` first.', ephemeral: true });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select')
      .setPlaceholder('Choose a ticket type')
      .addOptions(types.map((item) => ({ label: item.name, value: item.name })));

    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.reply({ embeds: [createEmbed('Open a Support Ticket', 'Choose the type of ticket you need.', 0x3498db)], components: [row], ephemeral: true });
    return;
  }

  if (commandName === 'roleembed') {
    const title = options.getString('title');
    const description = options.getString('description');
    const role = options.getRole('role');
    const label = options.getString('label');

    const button = new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    const message = await interaction.channel.send({ embeds: [createEmbed(title, description, 0x5865f2)], components: [row] });
    addRoleButton(guild.id, message.id, role.id, label);
    await interaction.reply({ content: 'Role button created.', ephemeral: true });
    return;
  }
}

async function handlePrefixCommand(message) {
  if (message.author.bot || !message.guild) return;

  const prefix = getGuildPrefix(message.guild.id) || '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const guild = message.guild;

  if (command === 'ban') {
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) {
      await message.reply('Usage: `!ban @user reason`');
      return;
    }
    await guild.members.ban(target.id, { reason });
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: message.author.id, action: 'ban', reason });
    await message.reply({ embeds: [createEmbed('User Banned', `${target} was banned. Reason: ${reason}`, 0xe74c3c)] });
    await logEvent(guild, 'Ban', `${target} was banned by ${message.author}. Reason: ${reason}`, 0xe74c3c);
    return;
  }

  if (command === 'kick') {
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) {
      await message.reply('Usage: `!kick @user reason`');
      return;
    }
    await target.kick(reason);
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: message.author.id, action: 'kick', reason });
    await message.reply({ embeds: [createEmbed('User Kicked', `${target} was kicked. Reason: ${reason}`, 0xf39c12)] });
    await logEvent(guild, 'Kick', `${target} was kicked by ${message.author}. Reason: ${reason}`, 0xf39c12);
    return;
  }

  if (command === 'mute') {
    const target = message.mentions.members?.first();
    const duration = args[1];
    const reason = args.slice(2).join(' ') || 'No reason provided';
    const ms = parseTimeToMs(duration);
    if (!target || !ms) {
      await message.reply('Usage: `!mute @user 10m reason`');
      return;
    }
    await target.timeout(ms, reason);
    setMute(guild.id, target.id, Date.now() + ms, reason);
    addModerationRecord({ guildId: guild.id, userId: target.id, moderatorId: message.author.id, action: 'mute', reason });
    await message.reply({ embeds: [createEmbed('User Muted', `${target} was muted for ${duration}.`, 0x9b59b6)] });
    await logEvent(guild, 'Mute', `${target} was muted by ${message.author} for ${duration}. Reason: ${reason}`, 0x9b59b6);
    return;
  }

  if (command === 'unmute') {
    const target = message.mentions.members?.first();
    if (!target) {
      await message.reply('Usage: `!unmute @user`');
      return;
    }
    await target.timeout(null).catch(() => {});
    clearMute(guild.id, target.id);
    await message.reply({ embeds: [createEmbed('User Unmuted', `${target} was unmuted.`, 0x2ecc71)] });
    return;
  }

  if (command === 'warn') {
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) {
      await message.reply('Usage: `!warn @user reason`');
      return;
    }
    addWarning({ guildId: guild.id, userId: target.id, moderatorId: message.author.id, reason });
    await message.reply({ embeds: [createEmbed('User Warned', `${target} was warned. Reason: ${reason}`, 0xf1c40f)] });
    return;
  }

  if (command === 'setlog') {
    const channel = message.mentions.channels.first();
    if (!channel) {
      await message.reply('Usage: `!setlog #log-channel`');
      return;
    }
    setGuildSetting(guild.id, 'log_channel_id', channel.id);
    await message.reply({ embeds: [createEmbed('Logging Channel Set', `Logs will now be sent to ${channel}.`, 0x5865f2)] });
    return;
  }

  if (command === 'setprefix') {
    const newPrefix = args[0];
    if (!newPrefix) {
      await message.reply('Usage: `!setprefix $`');
      return;
    }
    setGuildPrefix(guild.id, newPrefix);
    await message.reply({ embeds: [createEmbed('Prefix Updated', `The prefix is now ${newPrefix}.`, 0x5865f2)] });
    return;
  }

  if (command === 'setupvoicehub') {
    const channel = message.mentions.channels.first();
    if (!channel) {
      await message.reply('Usage: `!setupvoicehub #hub-channel`');
      return;
    }
    setGuildSetting(guild.id, 'voice_hub_channel_id', channel.id);
    await message.reply({ embeds: [createEmbed('Voice Hub Set', `${channel} is now the temporary voice hub.`, 0x1abc9c)] });
    return;
  }

  if (command === 'settickettype') {
    const [name, categoryMention] = args;
    const category = message.mentions.channels.first();
    if (!name || !category) {
      await message.reply('Usage: `!settickettype general-support #category`');
      return;
    }
    addTicketType(guild.id, name, category.id);
    await message.reply({ embeds: [createEmbed('Ticket Type Added', `Ticket type ${name} created in ${category}.`, 0x3498db)] });
    return;
  }

  if (command === 'ticket') {
    const types = getTicketTypesByGuild(guild.id);
    if (!types.length) {
      await message.reply('No ticket types have been configured. Add one with `!settickettype` first.');
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select')
      .setPlaceholder('Choose a ticket type')
      .addOptions(types.map((item) => ({ label: item.name, value: item.name })));

    const row = new ActionRowBuilder().addComponents(menu);
    await message.reply({ embeds: [createEmbed('Open a Support Ticket', 'Select a ticket type below.', 0x3498db)], components: [row] });
    return;
  }

  if (command === 'roleembed') {
    const role = message.mentions.roles.first();
    const label = args[1] || 'Get Role';
    if (!role) {
      await message.reply('Usage: `!roleembed @role Label`');
      return;
    }

    const button = new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    const msg = await message.channel.send({ embeds: [createEmbed('Role Selection', `Click the button to get the ${role.name} role.`, 0x5865f2)], components: [row] });
    addRoleButton(guild.id, msg.id, role.id, label);
    await message.reply('Role embed created.');
    return;
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error('Failed to register slash commands:', error.message);
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
    return;
  }
});

client.on('guildMemberAdd', async (member) => {
  const settings = ensureGuildRecord(member.guild.id);

  if (settings.welcome_channel_id) {
    const channel = member.guild.channels.cache.get(settings.welcome_channel_id);
    if (channel) {
      const welcomeMessage = (settings.welcome_message || 'Welcome {user} to {guild}! We are glad to have you here!')
        .replace('{user}', `<@${member.id}>`)
        .replace('{guild}', member.guild.name);
      await channel.send({ embeds: [createEmbed('Welcome!', welcomeMessage, 0x5865f2)] });
    }
  }

  if (settings.auto_role_id) {
    const role = member.guild.roles.cache.get(settings.auto_role_id);
    if (role) await member.roles.add(role).catch(() => {});
  }

  if (settings.verify_channel_id && settings.verify_role_id) {
    const verifyChannel = member.guild.channels.cache.get(settings.verify_channel_id);
    const verifyRole = member.guild.roles.cache.get(settings.verify_role_id);
    if (verifyChannel && verifyRole) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`verify:${member.id}`).setLabel('Verify Me').setStyle(ButtonStyle.Success),
      );
      await verifyChannel.send({ content: `${member}, please verify yourself by clicking below.`, components: [row] });
    }
  }

  if (settings.alt_check_enabled) {
    const thresholdDays = Number(settings.alt_min_days || 7);
    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    if (accountAgeMs < thresholdDays * 24 * 60 * 60 * 1000) {
      await member.kick('Account is too new for this server.');
      await logEvent(member.guild, 'Alt Account Detected', `${member} was kicked because their account is younger than ${thresholdDays} days.`, 0xe67e22);
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  await logEvent(member.guild, 'Member Left', `${member.user.tag} left the server.`, 0x95a5a6);
});

client.on('messageDelete', async (message) => {
  if (message.author?.bot) return;
  await logEvent(message.guild, 'Message Deleted', `A message by ${message.author.tag} was deleted in ${message.channel}. Content: ${message.content || 'No content'}`, 0xe74c3c);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
  await logEvent(newMessage.guild, 'Message Updated', `${oldMessage.author.tag} edited a message in ${newMessage.channel}. Old: ${oldMessage.content || 'N/A'} | New: ${newMessage.content || 'N/A'}`, 0xf1c40f);
});

client.on('roleUpdate', async (oldRole, newRole) => {
  await logEvent(newRole.guild, 'Role Updated', `Role ${newRole.name} was updated.`, 0x3498db);
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild) return;
  await logEvent(newChannel.guild, 'Channel Updated', `Channel ${newChannel.name} was updated.`, 0x3498db);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const settings = ensureGuildRecord(guild.id);
  const hubId = settings.voice_hub_channel_id;

  if (hubId && newState.channelId === hubId && !newState.member.user.bot) {
    const channel = await guild.channels.create({
      name: `${newState.member.user.username}'s room`,
      type: ChannelType.GuildVoice,
      parent: newState.channel.parentId,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.Connect] },
        { id: newState.member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak] },
      ],
    });

    addTempVoiceChannel(guild.id, channel.id, newState.member.id);
    await newState.member.voice.setChannel(channel.id).catch(() => {});
  }

  const oldChannel = oldState.channel;
  if (oldChannel && oldChannel !== newState.channel && oldChannel.members.size === 0 && isTempVoiceChannel(oldChannel.id)) {
    await oldChannel.delete('Temporary voice channel cleanup.').catch(() => {});
    removeTempVoiceChannel(oldChannel.id);
  }
});

client.login(config.token).catch((error) => {
  console.error('Failed to start bot:', error.message);
  process.exit(1);
});

export { client };
