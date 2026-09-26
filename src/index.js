import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
  Routes,
  REST,
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
  addTicketType,
  getTicketTypesByGuild,
  addTempVoiceChannel,
  removeTempVoiceChannel,
  isTempVoiceChannel,
  addRoleButton,
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

function embed(title, description, color = 0x5865f2) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
}

function parseTimeToMs(value) {
  if (!value) return null;
  const match = value.match(/^((?:\d+)(?:[smhdw]))+$/i);
  if (!match) return null;

  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  let total = 0;
  const regex = /(\d+)([smhdw])/gi;
  let part;
  while ((part = regex.exec(value))) {
    total += Number(part[1]) * units[part[2].toLowerCase()];
  }
  return total;
}

function getLogChannel(guild) {
  const channelId = db.prepare('SELECT log_channel_id FROM guild_settings WHERE guild_id = ?').get(guild.id)?.log_channel_id;
  return channelId ? guild.channels.cache.get(channelId) : null;
}

async function logEvent(guild, title, description, color = 0x5865f2) {
  const channel = getLogChannel(guild);
  if (!channel) return;
  try {
    await channel.send({ embeds: [embed(title, description, color)] });
  } catch (error) {
    console.error(`Log failed for ${guild.name}: ${error.message}`);
  }
}

async function createTicketChannel(guild, user, ticketTypeName, categoryId) {
  const safeName = `${ticketTypeName.toLowerCase().replace(/[^a-z0-9-\s]/g, '').replace(/\s+/g, '-')}-${user.username}`;
  const parent = categoryId ? guild.channels.cache.get(categoryId) : null;

  const channel = await guild.channels.create({
    name: `ticket-${safeName}`.slice(0, 80),
    type: ChannelType.GuildText,
    parent: parent ? parent.id : null,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });

  const staffRoleIds = guild.roles.cache
    .filter((role) => role.permissions.has(PermissionFlagsBits.ManageGuild) || role.permissions.has(PermissionFlagsBits.ModerateMembers))
    .map((role) => role.id);

  for (const roleId of staffRoleIds) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => {});
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`close_ticket:${channel.id}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`lock_ticket:${channel.id}`).setLabel('Lock').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`add_user_ticket:${channel.id}`).setLabel('Add User').setStyle(ButtonStyle.Primary),
  );

  await channel.send({
    embeds: [embed(`Ticket: ${ticketTypeName}`, `Hey ${user}, a staff member will be with you shortly.`, 0x00b894)],
    components: [buttons],
  });

  return channel;
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
    const hasRole = member.roles.cache.has(roleId);
    await (hasRole ? member.roles.remove(roleId) : member.roles.add(roleId));
    await interaction.reply({ content: `${hasRole ? 'Removed' : 'Added'} the ${role.name} role.`, ephemeral: true });
    return;
  }

  if (type === 'verify') {
    const settings = ensureGuildSettings(interaction.guild.id);
    const verifyRole = settings.verify_role_id ? interaction.guild.roles.cache.get(settings.verify_role_id) : null;
    if (!verifyRole) {
      await interaction.reply({ content: 'Verification role is not configured.', ephemeral: true });
      return;
    }

    const member = interaction.guild.members.cache.get(interaction.user.id) || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return;

    const thresholdMs = (settings.alt_min_days || 7) * 24 * 60 * 60 * 1000;
    const isAltAccount = settings.alt_check_enabled && Date.now() - member.user.createdTimestamp < thresholdMs;

    if (isAltAccount) {
      await member.kick('Alt account detected during verification.');
      await interaction.reply({ content: 'Your account is too new for this server. Please contact staff.', ephemeral: true });
      return;
    }

    await member.roles.add(verifyRole);
    await interaction.reply({ content: `You are now verified in ${interaction.guild.name}.`, ephemeral: true });
    return;
  }

  if (type === 'close_ticket') {
    const channel = interaction.guild.channels.cache.get(rest[0]);
    if (channel) {
      await channel.delete(`Ticket closed by ${interaction.user.id}`).catch(() => {});
    }
    await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
    return;
  }

  if (type === 'lock_ticket') {
    const channel = interaction.guild.channels.cache.get(rest[0]);
    if (channel) {
      await channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false, ViewChannel: true, ReadMessageHistory: true }).catch(() => {});
    }
    await interaction.reply({ content: 'Ticket locked.', ephemeral: true });
    return;
  }

  if (type === 'add_user_ticket') {
    const channel = interaction.guild.channels.cache.get(rest[0]);
    if (!channel) {
      await interaction.reply({ content: 'Ticket not found.', ephemeral: true });
      return;
    }

    const prompt = await interaction.reply({ content: 'Mention the user you want to add to this ticket.', fetchReply: true, ephemeral: true });
    const collected = await interaction.channel.awaitMessages({
      filter: (msg) => msg.author.id === interaction.user.id,
      max: 1,
      time: 20000,
    });

    const member = collected.first()?.mentions.members?.first();
    if (!member) {
      await interaction.followUp({ content: 'No valid user was mentioned.', ephemeral: true });
      return;
    }

    await channel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => {});

    await interaction.followUp({ content: `${member} has been added to the ticket.`, ephemeral: true });
  }
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'ticket_select') return;

  const selected = interaction.values[0];
  const type = getTicketTypesByGuild(interaction.guild.id).find((item) => item.name.toLowerCase() === selected.toLowerCase());
  if (!type) {
    await interaction.reply({ content: 'Ticket type not found.', ephemeral: true });
    return;
  }

  const channel = await createTicketChannel(interaction.guild, interaction.user, type.name, type.category_id);
  await interaction.reply({ content: `Ticket created: ${channel}`, ephemeral: true });
}

async function registerSlashCommands() {
  if (!config.clientId || !config.guildId || !config.token) {
    console.warn('Skipping command registration: CLIENT_ID, GUILD_ID, or DISCORD_TOKEN is missing.');
    return;
  }

  const commands = [
    { name: 'ban', description: 'Ban a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'kick', description: 'Kick a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'mute', description: 'Mute a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'duration', type: 3, required: true }, { name: 'reason', type: 3, required: false }] },
    { name: 'unmute', description: 'Unmute a member.', options: [{ name: 'user', type: 6, required: true }] },
    { name: 'warn', description: 'Warn a member.', options: [{ name: 'user', type: 6, required: true }, { name: 'reason', type: 3, required: true }] },
    { name: 'setlog', description: 'Set the moderation log channel.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }] },
    { name: 'setprefix', description: 'Set the server prefix.', options: [{ name: 'prefix', type: 3, required: true }] },
    { name: 'setwelcome', description: 'Set the welcome channel and role.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }, { name: 'role', type: 8, required: false }, { name: 'message', type: 3, required: false }] },
    { name: 'setupverify', description: 'Set verification settings.', options: [{ name: 'channel', type: 7, required: true, channel_types: [0] }, { name: 'role', type: 8, required: true }, { name: 'min_days', type: 4, required: false }] },
    { name: 'setupvoicehub', description: 'Set the join-to-create voice hub.', options: [{ name: 'channel', type: 7, required: true, channel_types: [2] }] },
    { name: 'settickettype', description: 'Create a ticket type.', options: [{ name: 'name', type: 3, required: true }, { name: 'category', type: 7, required: true, channel_types: [4] }] },
    { name: 'ticket', description: 'Open a ticket.', options: [] },
    { name: 'roleembed', description: 'Create a role button embed.', options: [{ name: 'title', type: 3, required: true }, { name: 'description', type: 3, required: true }, { name: 'role', type: 8, required: true }, { name: 'label', type: 3, required: true }] },
  ];

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
  console.log('Slash commands registered.');
}

async function handleSlashCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, options } = interaction;

  if (commandName === 'ban') {
    const user = options.getMember('user');
    const reason = options.getString('reason') || 'No reason provided';
    if (!user) {
      await interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      return;
    }

    await guild.members.ban(user.id, { reason });
    addModerationRecord({ guildId: guild.id, userId: user.id, moderatorId: member.id, action: 'ban', reason });
    await interaction.reply({ embeds: [embed('User Banned', `${user} has been banned. Reason: ${reason}`, 0xe74c3c)] });
    await logEvent(guild, 'Ban', `${user} was banned by ${member}. Reason: ${reason}`, 0xe74c3c);
    return;
  }

  if (commandName === 'kick') {
    const user = options.getMember('user');
    const reason = options.getString('reason') || 'No reason provided';
    if (!user) {
      await interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      return;
    }

    await user.kick(reason);
    addModerationRecord({ guildId: guild.id, userId: user.id, moderatorId: member.id, action: 'kick', reason });
    await interaction.reply({ embeds: [embed('User Kicked', `${user} has been kicked. Reason: ${reason}`, 0xf39c12)] });
    await logEvent(guild, 'Kick', `${user} was kicked by ${member}. Reason: ${reason}`, 0xf39c12);
    return;
  }

  if (commandName === 'mute') {
    const user = options.getMember('user');
    const ms = parseTimeToMs(options.getString('duration'));
    const reason = options.getString('reason') || 'No reason provided';
    if (!user || !ms) {
      await interaction.reply({ content: 'Use a valid duration such as `10m`, `1h`, or `2d`.', ephemeral: true });
      return;
    }

    await user.timeout(ms, reason);
    setMute(guild.id, user.id, Date.now() + ms, reason);
    addModerationRecord({ guildId: guild.id, userId: user.id, moderatorId: member.id, action: 'mute', reason });
    await interaction.reply({ embeds: [embed('User Muted', `${user} has been muted for ${options.getString('duration')}.`, 0x9b59b6)] });
    await logEvent(guild, 'Mute', `${user} was muted by ${member} for ${options.getString('duration')}. Reason: ${reason}`, 0x9b59b6);
    return;
  }

  if (commandName === 'unmute') {
    const user = options.getMember('user');
    if (!user) {
      await interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      return;
    }

    await user.timeout(null).catch(() => {});
    clearMute(guild.id, user.id);
    addModerationRecord({ guildId: guild.id, userId: user.id, moderatorId: member.id, action: 'unmute', reason: 'Removed mute' });
    await interaction.reply({ embeds: [embed('User Unmuted', `${user} has been unmuted.`, 0x2ecc71)] });
    await logEvent(guild, 'Unmute', `${user} was unmuted by ${member}.`, 0x2ecc71);
    return;
  }

  if (commandName === 'warn') {
    const user = options.getMember('user');
    const reason = options.getString('reason') || 'No reason provided';
    if (!user) {
      await interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      return;
    }

    addWarning({ guildId: guild.id, userId: user.id, moderatorId: member.id, reason });
    addModerationRecord({ guildId: guild.id, userId: user.id, moderatorId: member.id, action: 'warn', reason });
    const count = getWarnings(guild.id, user.id).length;
    await interaction.reply({ embeds: [embed('User Warned', `${user} has been warned. Total warnings: ${count}. Reason: ${reason}`, 0xf1c40f)] });
    await logEvent(guild, 'Warning', `${user} was warned by ${member}. Reason: ${reason}`, 0xf1c40f);
    return;
  }

  if (commandName === 'setlog') {
    const channel = options.getChannel('channel');
    setGuildSetting(guild.id, 'log_channel_id', channel.id);
    await interaction.reply({ embeds: [embed('Log Channel Set', `Logs will now be sent to ${channel}.`, 0x5865f2)] });
    return;
  }

  if (commandName === 'setprefix') {
    const prefix = options.getString('prefix');
    setGuildPrefix(guild.id, prefix);
    await interaction.reply({ embeds: [embed('Prefix Updated', `This server prefix is now ${prefix}.`, 0x5865f2)] });
    return;
  }

  if (commandName === 'setwelcome') {
    const channel = options.getChannel('channel');
    const role = options.getRole('role');
    const message = options.getString('message') || 'Welcome {user} to {guild}! We are glad to have you here!';
    setGuildSetting(guild.id, 'welcome_channel_id', channel.id);
    setGuildSetting(guild.id, 'welcome_message', message);
    if (role) setGuildSetting(guild.id, 'auto_role_id', role.id);
    await interaction.reply({ embeds: [embed('Welcome Settings Updated', `Welcome channel: ${channel}; Auto-role: ${role || 'None'}.`, 0x00b894)] });
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
    await interaction.reply({ embeds: [embed('Verification Set Up', `Verify channel: ${channel}; Role: ${role}; Min account age: ${minDays} days.`, 0x00b894)] });
    return;
  }

  if (commandName === 'setupvoicehub') {
    const channel = options.getChannel('channel');
    setGuildSetting(guild.id, 'voice_hub_channel_id', channel.id);
    await interaction.reply({ embeds: [embed('Voice Hub Set', `${channel} is now the join-to-create voice hub.`, 0x1abc9c)] });
    return;
  }

  if (commandName === 'settickettype') {
    const name = options.getString('name');
    const category = options.getChannel('category');
    addTicketType(guild.id, name, category.id);
    await interaction.reply({ embeds: [embed('Ticket Type Added', `Ticket type: ${name} | Category: ${category}`, 0x3498db)] });
    return;
  }

  if (commandName === 'ticket') {
    const types = getTicketTypesByGuild(guild.id);
    if (!types.length) {
      await interaction.reply({ content: 'No ticket types are configured. Use `/settickettype` first.', ephemeral: true });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket_select')
      .setPlaceholder('Choose a ticket type')
      .addOptions(types.map((type) => ({ label: type.name, value: type.name })));

    await interaction.reply({
      embeds: [embed('Open a Ticket', 'Choose the type of ticket you want to create.', 0x3498db)],
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true,
    });
    return;
  }

  if (commandName === 'roleembed') {
    const title = options.getString('title');
    const description = options.getString('description');
    const role = options.getRole('role');
    const label = options.getString('label');

    const button = new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary);
    const message = await interaction.channel.send({
      embeds: [embed(title, description, 0x5865f2)],
      components: [new ActionRowBuilder().addComponents(button)],
    });

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
  const command = args.shift() || '';
  if (!command) return;

  const guild = message.guild;

  if (command === 'ban') {
    const member = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!member) {
      await message.reply('Usage: `!ban @user reason`');
      return;
    }
    await guild.members.ban(member.id, { reason });
    addModerationRecord({ guildId: guild.id, userId: member.id, moderatorId: message.author.id, action: 'ban', reason });
    await message.reply({ embeds: [embed('User Banned', `${member} was banned. Reason: ${reason}`, 0xe74c3c)] });
    await logEvent(guild, 'Ban', `${member} was banned by ${message.author}. Reason: ${reason}`, 0xe74c3c);
    return;
  }

  if (command === 'kick') {
    const member = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!member) {
      await message.reply('Usage: `!kick @user reason`');
      return;
    }
    await member.kick(reason);
    addModerationRecord({ guildId: guild.id, userId: member.id, moderatorId: message.author.id, action: 'kick', reason });
    await message.reply({ embeds: [embed('User Kicked', `${member} was kicked. Reason: ${reason}`, 0xf39c12)] });
    await logEvent(guild, 'Kick', `${member} was kicked by ${message.author}. Reason: ${reason}`, 0xf39c12);
    return;
  }

  if (command === 'mute') {
    const member = message.mentions.members?.first();
    const duration = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const ms = parseTimeToMs(duration);
    if (!member || !ms) {
      await message.reply('Usage: `!mute @user 10m reason`');
      return;
    }

    await member.timeout(ms, reason);
    setMute(guild.id, member.id, Date.now() + ms, reason);
    addModerationRecord({ guildId: guild.id, userId: member.id, moderatorId: message.author.id, action: 'mute', reason });
    await message.reply({ embeds: [embed('User Muted', `${member} was muted for ${duration}.`, 0x9b59b6)] });
    await logEvent(guild, 'Mute', `${member} was muted by ${message.author} for ${duration}. Reason: ${reason}`, 0x9b59b6);
    return;
  }

  if (command === 'unmute') {
    const member = message.mentions.members?.first();
    if (!member) {
      await message.reply('Usage: `!unmute @user`');
      return;
    }
    await member.timeout(null).catch(() => {});
    clearMute(guild.id, member.id);
    await message.reply({ embeds: [embed('User Unmuted', `${member} was unmuted.`, 0x2ecc71)] });
    return;
  }

  if (command === 'warn') {
    const member = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!member) {
      await message.reply('Usage: `!warn @user reason`');
      return;
    }
    addWarning({ guildId: guild.id, userId: member.id, moderatorId: message.author.id, reason });
    await message.reply({ embeds: [embed('User Warned', `${member} was warned. Reason: ${reason}`, 0xf1c40f)] });
    return;
  }

  if (command === 'setlog') {
    const channel = message.mentions.channels.first();
    if (!channel) {
      await message.reply('Usage: `!setlog #log-channel`');
      return;
    }
    setGuildSetting(guild.id, 'log_channel_id', channel.id);
    await message.reply({ embeds: [embed('Log Channel Set', `Logs will now be sent to ${channel}.`, 0x5865f2)] });
    return;
  }

  if (command === 'setprefix') {
    const newPrefix = args[0];
    if (!newPrefix) {
      await message.reply('Usage: `!setprefix $`');
      return;
    }
    setGuildPrefix(guild.id, newPrefix);
    await message.reply({ embeds: [embed('Prefix Updated', `This server prefix is now ${newPrefix}.`, 0x5865f2)] });
    return;
  }

  if (command === 'setupvoicehub') {
    const channel = message.mentions.channels.first();
    if (!channel) {
      await message.reply('Usage: `!setupvoicehub #hub-channel`');
      return;
    }
    setGuildSetting(guild.id, 'voice_hub_channel_id', channel.id);
    await message.reply({ embeds: [embed('Voice Hub Set', `${channel} is now the temporary voice hub.`, 0x1abc9c)] });
    return;
  }

  if (command === 'settickettype') {
    const name = args[0];
    const category = message.mentions.channels.first();
    if (!name || !category) {
      await message.reply('Usage: `!settickettype support #category`');
      return;
    }
    addTicketType(guild.id, name, category.id);
    await message.reply({ embeds: [embed('Ticket Type Added', `Ticket type ${name} created in ${category}.`, 0x3498db)] });
    return;
  }

  if (command === 'ticket') {
    const types = getTicketTypesByGuild(guild.id);
    if (!types.length) {
      await message.reply('No ticket types are configured. Use `!settickettype` first.');
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId('ticket_select')
      .setPlaceholder('Choose a ticket type')
      .addOptions(types.map((type) => ({ label: type.name, value: type.name })));

    await message.reply({
      embeds: [embed('Open a Ticket', 'Choose the type of support you need below.', 0x3498db)],
      components: [new ActionRowBuilder().addComponents(select)],
    });
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
    const msg = await message.channel.send({
      embeds: [embed('Role Selection', `Click the button to get the ${role.name} role.`, 0x5865f2)],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    addRoleButton(guild.id, msg.id, role.id, label);
    await message.reply('Role embed created.');
  }
}

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
    await handleSelectMenu(interaction);
  }
});

client.on('guildMemberAdd', async (member) => {
  const settings = ensureGuildSettings(member.guild.id);

  if (settings.welcome_channel_id) {
    const channel = member.guild.channels.cache.get(settings.welcome_channel_id);
    if (channel) {
      const text = (settings.welcome_message || 'Welcome {user} to {guild}! We are glad to have you here!')
        .replace('{user}', `<@${member.id}>`)
        .replace('{guild}', member.guild.name);
      await channel.send({ embeds: [embed('Welcome!', text, 0x5865f2)] });
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
      await verifyChannel.send({ content: `${member}, click below to verify yourself.`, components: [row] });
    }
  }

  if (settings.alt_check_enabled) {
    const thresholdDays = Number(settings.alt_min_days || 7);
    const ageMs = Date.now() - member.user.createdTimestamp;
    if (ageMs < thresholdDays * 24 * 60 * 60 * 1000) {
      await member.kick('Account is too new for this server.');
      await logEvent(member.guild, 'Alt Account Detected', `${member} was kicked because their account is younger than ${thresholdDays} days.`, 0xe67e22);
    }
  }
});

client.on('guildMemberRemove', async (member) => {
  await logEvent(member.guild, 'Member Left', `${member.user.tag} left the server.`, 0x95a5a6);
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  await logEvent(message.guild, 'Message Deleted', `A message by ${message.author.tag} was deleted in ${message.channel}. Content: ${message.content || 'No content'}`, 0xe74c3c);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
  await logEvent(newMessage.guild, 'Message Updated', `${oldMessage.author.tag} edited a message in ${newMessage.channel}. Old: ${oldMessage.content || 'N/A'} | New: ${newMessage.content || 'N/A'}`, 0xf1c40f);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  const settings = ensureGuildSettings(guild.id);
  const hubId = settings.voice_hub_channel_id;

  if (hubId && newState.channelId === hubId && !newState.member.user.bot) {
    const privateChannel = await guild.channels.create({
      name: `${newState.member.user.username}'s room`,
      type: ChannelType.GuildVoice,
      parent: newState.channel?.parentId ?? null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.Connect] },
        { id: newState.member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak] },
      ],
    });

    addTempVoiceChannel(guild.id, privateChannel.id, newState.member.id);
    await newState.member.voice.setChannel(privateChannel.id).catch(() => {});
  }

  const oldChannel = oldState.channel;
  if (oldChannel && oldChannel !== newState.channel && oldChannel.members.size === 0 && isTempVoiceChannel(oldChannel.id)) {
    await oldChannel.delete('Temporary voice channel cleanup.').catch(() => {});
    removeTempVoiceChannel(oldChannel.id);
  }
});

client.login(config.token).catch((error) => {
  console.error('Failed to login:', error.message);
  process.exit(1);
});

export { client };
