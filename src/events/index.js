import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import {
  addModerationRecord,
  addRoleButton,
  addTicketType,
  addWarning,
  clearMute,
  getGuildPrefix,
  getGuildSetting,
  getMute,
  getRoleButtonData,
  getWarnings,
  listTicketTypes,
  setGuildPrefix,
  setGuildSetting,
  setMute,
  addTempVoiceChannel,
  removeTempVoiceChannel,
  isTempVoiceChannel,
} from '../db.js';

const MOD_PERMISSIONS = [
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageGuild,
];

function parseDuration(input) {
  if (!input) return 0;
  const match = /^([0-9]+)([smhd])$/i.exec(String(input).trim());
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * multipliers[unit];
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'Permanent';
  const totalSeconds = Math.round(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

function canModerate(member) {
  if (!member) return false;
  return MOD_PERMISSIONS.some((permission) => member.permissions.has(permission));
}

async function safeReply(interaction, content, options = {}) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ content, ...options }).catch(() => null);
  }
  return interaction.reply({ content, ...options }).catch(() => null);
}

async function logAction(guild, message) {
  const channelId = getGuildSetting(guild.id, 'log_channel_id');
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0x5865f2).setDescription(message).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => null);
}

async function memberCanBeModerated(guild, actor, target) {
  if (!target) return false;
  if (actor.id === guild.ownerId) return true;
  if (target.id === guild.ownerId) return false;

  const actorTop = actor.roles.highest;
  const targetTop = target.roles.highest;

  if (actorTop && targetTop && actorTop.comparePositionTo(targetTop) <= 0 && actor.id !== guild.ownerId) {
    return false;
  }

  return true;
}

export async function registerSlashCommands() {
  if (!config.token || !config.clientId || !config.guildId) {
    console.warn('Skipping slash command registration: missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID');
    return;
  }

  const commands = [
    new SlashCommandBuilder().setName('ban').setDescription('Ban a member').addUserOption((option) => option.setName('user').setDescription('Member to ban').setRequired(true)).addStringOption((option) => option.setName('reason').setDescription('Reason for the ban').setRequired(false)),
    new SlashCommandBuilder().setName('kick').setDescription('Kick a member').addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true)).addStringOption((option) => option.setName('reason').setDescription('Reason for the kick').setRequired(false)),
    new SlashCommandBuilder().setName('mute').setDescription('Mute a member').addUserOption((option) => option.setName('user').setDescription('Member to mute').setRequired(true)).addStringOption((option) => option.setName('duration').setDescription('Mute duration such as 10m, 2h, 1d').setRequired(true)).addStringOption((option) => option.setName('reason').setDescription('Reason for the mute').setRequired(false)),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute a member').addUserOption((option) => option.setName('user').setDescription('Member to unmute').setRequired(true)),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a member').addUserOption((option) => option.setName('user').setDescription('Member to warn').setRequired(true)).addStringOption((option) => option.setName('reason').setDescription('Reason for the warning').setRequired(true)),
    new SlashCommandBuilder().setName('setlog').setDescription('Set the moderation log channel').addChannelOption((option) => option.setName('channel').setDescription('Channel to use for logs').setRequired(true)),
    new SlashCommandBuilder().setName('setprefix').setDescription('Set the guild prefix').addStringOption((option) => option.setName('prefix').setDescription('New prefix').setRequired(true)),
    new SlashCommandBuilder().setName('setwelcome').setDescription('Set welcome channel and message').addChannelOption((option) => option.setName('channel').setDescription('Channel for welcome messages').setRequired(true)).addStringOption((option) => option.setName('message').setDescription('Welcome message template').setRequired(false)),
    new SlashCommandBuilder().setName('setupverify').setDescription('Setup verification role and channel').addChannelOption((option) => option.setName('channel').setDescription('Verification channel').setRequired(true)).addRoleOption((option) => option.setName('role').setDescription('Role to give after verification').setRequired(true)),
    new SlashCommandBuilder().setName('setupvoicehub').setDescription('Set the temporary voice hub channel').addChannelOption((option) => option.setName('channel').setDescription('Voice channel to act as hub').setRequired(true)),
    new SlashCommandBuilder().setName('settickettype').setDescription('Register a ticket type').addStringOption((option) => option.setName('name').setDescription('Ticket type name').setRequired(true)).addChannelOption((option) => option.setName('category').setDescription('Category for this ticket type').setRequired(true)).addRoleOption((option) => option.setName('role').setDescription('Role that can access the tickets').setRequired(false)),
    new SlashCommandBuilder().setName('ticket').setDescription('Open a ticket').addStringOption((option) => option.setName('type').setDescription('Ticket type').setRequired(true)),
    new SlashCommandBuilder().setName('roleembed').setDescription('Create a role assignment button').addRoleOption((option) => option.setName('role').setDescription('Role to assign via button').setRequired(true)),
  ];

  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: commands.map((command) => command.toJSON()),
  });
}

async function executeModeration(interaction, action, target, reason) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to use moderation commands.', { ephemeral: true });
  }

  if (!target) {
    return safeReply(interaction, 'Target user not found.', { ephemeral: true });
  }

  const guildMember = interaction.guild.members.cache.get(target.id) || (await interaction.guild.members.fetch(target.id).catch(() => null));
  if (!guildMember) {
    return safeReply(interaction, 'That user is not in this guild.', { ephemeral: true });
  }

  const allowed = await memberCanBeModerated(interaction.guild, interaction.member, guildMember);
  if (!allowed) {
    return safeReply(interaction, 'You cannot moderate someone with a role equal to or higher than yours.', { ephemeral: true });
  }

  if (action === 'ban') {
    await interaction.guild.members.ban(target.id, { reason: reason || 'No reason provided' }).catch(() => null);
    addModerationRecord({ guildId: interaction.guild.id, userId: target.id, moderatorId: interaction.user.id, action: 'ban', reason: reason || 'No reason provided' });
    await logAction(interaction.guild, `**Ban**: <@${target.id}> by <@${interaction.user.id}> - ${reason || 'No reason provided'}`);
    return safeReply(interaction, `Banned <@${target.id}>.`);
  }

  if (action === 'kick') {
    await guildMember.kick(reason || 'No reason provided').catch(() => null);
    addModerationRecord({ guildId: interaction.guild.id, userId: target.id, moderatorId: interaction.user.id, action: 'kick', reason: reason || 'No reason provided' });
    await logAction(interaction.guild, `**Kick**: <@${target.id}> by <@${interaction.user.id}> - ${reason || 'No reason provided'}`);
    return safeReply(interaction, `Kicked <@${target.id}>.`);
  }

  return null;
}

async function handleBanCommand(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  return executeModeration(interaction, 'ban', user, reason);
}

async function handleKickCommand(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  return executeModeration(interaction, 'kick', user, reason);
}

async function handleMuteCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to use moderation commands.', { ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const durationInput = interaction.options.getString('duration');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  const ms = parseDuration(durationInput);

  if (!user || !ms) {
    return safeReply(interaction, 'Please provide a valid mute duration such as 10m, 2h, or 1d.', { ephemeral: true });
  }

  const member = interaction.guild.members.cache.get(user.id) || (await interaction.guild.members.fetch(user.id).catch(() => null));
  if (!member) {
    return safeReply(interaction, 'That user is not in this guild.', { ephemeral: true });
  }

  const allowed = await memberCanBeModerated(interaction.guild, interaction.member, member);
  if (!allowed) {
    return safeReply(interaction, 'You cannot moderate someone with a role equal to or higher than yours.', { ephemeral: true });
  }

  const untilEpoch = Date.now() + ms;
  await member.timeout(untilEpoch, reason).catch(() => null);
  setMute(interaction.guild.id, user.id, untilEpoch, reason);
  addModerationRecord({ guildId: interaction.guild.id, userId: user.id, moderatorId: interaction.user.id, action: 'mute', reason: `${reason} (${formatDuration(ms)})` });
  await logAction(interaction.guild, `**Mute**: <@${user.id}> by <@${interaction.user.id}> - ${reason} (${formatDuration(ms)})`);
  return safeReply(interaction, `Muted <@${user.id}> for ${formatDuration(ms)}.`);
}

async function handleUnmuteCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to use moderation commands.', { ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const member = interaction.guild.members.cache.get(user.id) || (await interaction.guild.members.fetch(user.id).catch(() => null));
  if (!member) {
    return safeReply(interaction, 'That user is not in this guild.', { ephemeral: true });
  }

  await member.timeout(null).catch(() => null);
  clearMute(interaction.guild.id, user.id);
  addModerationRecord({ guildId: interaction.guild.id, userId: user.id, moderatorId: interaction.user.id, action: 'unmute', reason: 'Mute removed' });
  await logAction(interaction.guild, `**Unmute**: <@${user.id}> by <@${interaction.user.id}>`);
  return safeReply(interaction, `Unmuted <@${user.id}>.`);
}

async function handleWarnCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to use moderation commands.', { ephemeral: true });
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason provided';
  const member = interaction.guild.members.cache.get(user.id) || (await interaction.guild.members.fetch(user.id).catch(() => null));
  if (!member) {
    return safeReply(interaction, 'That user is not in this guild.', { ephemeral: true });
  }

  const allowed = await memberCanBeModerated(interaction.guild, interaction.member, member);
  if (!allowed) {
    return safeReply(interaction, 'You cannot warn someone with a role equal to or higher than yours.', { ephemeral: true });
  }

  addWarning({ guildId: interaction.guild.id, userId: user.id, moderatorId: interaction.user.id, reason });
  addModerationRecord({ guildId: interaction.guild.id, userId: user.id, moderatorId: interaction.user.id, action: 'warn', reason });
  await logAction(interaction.guild, `**Warn**: <@${user.id}> by <@${interaction.user.id}> - ${reason}`);
  return safeReply(interaction, `Warned <@${user.id}> for: ${reason}`);
}

async function handleSetLogCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage bot settings.', { ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel');
  setGuildSetting(interaction.guild.id, 'log_channel_id', channel.id);
  await logAction(interaction.guild, `**Log setup**: Log channel set to <#${channel.id}>`);
  return safeReply(interaction, `Moderation logs will be sent to <#${channel.id}>.`);
}

async function handleSetPrefixCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage bot settings.', { ephemeral: true });
  }

  const prefix = interaction.options.getString('prefix');
  setGuildPrefix(interaction.guild.id, prefix);
  return safeReply(interaction, `Prefix updated to \`${prefix}\`.`);
}

async function handleSetWelcomeCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage bot settings.', { ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message') || 'Welcome {user} to {guild}! We are glad to have you here!';
  setGuildSetting(interaction.guild.id, 'welcome_channel_id', channel.id);
  setGuildSetting(interaction.guild.id, 'welcome_message', message);
  return safeReply(interaction, `Welcome channel set to <#${channel.id}>.`);
}

async function handleSetupVerifyCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage bot settings.', { ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel');
  const role = interaction.options.getRole('role');
  setGuildSetting(interaction.guild.id, 'verify_channel_id', channel.id);
  setGuildSetting(interaction.guild.id, 'verify_role_id', role.id);
  return safeReply(interaction, `Verification channel set to <#${channel.id}> and role set to <@&${role.id}>.`);
}

async function handleSetupVoiceHubCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage bot settings.', { ephemeral: true });
  }

  const channel = interaction.options.getChannel('channel');
  setGuildSetting(interaction.guild.id, 'voice_hub_channel_id', channel.id);
  return safeReply(interaction, `Voice hub channel set to <#${channel.id}>.`);
}

async function handleSetTicketTypeCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage ticket settings.', { ephemeral: true });
  }

  const name = interaction.options.getString('name');
  const category = interaction.options.getChannel('category');
  const role = interaction.options.getRole('role');
  addTicketType(interaction.guild.id, name, category.id, role ? role.id : null);
  setGuildSetting(interaction.guild.id, 'ticket_category_id', category.id);
  return safeReply(interaction, `Ticket type \`${name}\` registered for <#${category.id}>.`);
}

async function handleTicketCommand(interaction) {
  const ticketTypeName = interaction.options.getString('type');
  const guild = interaction.guild;
  const ticketTypes = listTicketTypes(guild.id);
  const selectedType = ticketTypes.find((type) => type.name.toLowerCase() === ticketTypeName.toLowerCase());

  if (!selectedType) {
    return safeReply(interaction, `No ticket type named \`${ticketTypeName}\` exists.`, { ephemeral: true });
  }

  const category = guild.channels.cache.get(selectedType.category_id) || (await guild.channels.fetch(selectedType.category_id).catch(() => null));
  if (!category) {
    return safeReply(interaction, 'The configured ticket category no longer exists.', { ephemeral: true });
  }

  const channelName = `${ticketTypeName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 80);
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ],
  });

  if (selectedType.role_id) {
    channel.permissionOverwrites.edit(selectedType.role_id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`Ticket: ${ticketTypeName}`)
    .setDescription(`Thanks for contacting support, <@${interaction.user.id}>. An agent will be here shortly.`)
    .setTimestamp();

  const message = await channel.send({ embeds: [embed] });
  await message.pin().catch(() => null);
  return safeReply(interaction, `Your ticket is ready: <#${channel.id}>`, { ephemeral: true });
}

async function handleRoleEmbedCommand(interaction) {
  if (!canModerate(interaction.member)) {
    return safeReply(interaction, 'You do not have permission to manage role buttons.', { ephemeral: true });
  }

  const role = interaction.options.getRole('role');
  const channel = interaction.channel;
  const button = new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder().addComponents(button);
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Role assignment').setDescription(`Click below to get the ${role.name} role.`);
  const message = await channel.send({ embeds: [embed], components: [row] });
  addRoleButton(interaction.guild.id, message.id, role.id, role.name);
  return safeReply(interaction, `Role button created for <@&${role.id}>.`, { ephemeral: true });
}

export async function handleSlashCommand(interaction) {
  if (!interaction.guild) return;

  switch (interaction.commandName) {
    case 'ban':
      return handleBanCommand(interaction);
    case 'kick':
      return handleKickCommand(interaction);
    case 'mute':
      return handleMuteCommand(interaction);
    case 'unmute':
      return handleUnmuteCommand(interaction);
    case 'warn':
      return handleWarnCommand(interaction);
    case 'setlog':
      return handleSetLogCommand(interaction);
    case 'setprefix':
      return handleSetPrefixCommand(interaction);
    case 'setwelcome':
      return handleSetWelcomeCommand(interaction);
    case 'setupverify':
      return handleSetupVerifyCommand(interaction);
    case 'setupvoicehub':
      return handleSetupVoiceHubCommand(interaction);
    case 'settickettype':
      return handleSetTicketTypeCommand(interaction);
    case 'ticket':
      return handleTicketCommand(interaction);
    case 'roleembed':
      return handleRoleEmbedCommand(interaction);
    default:
      return safeReply(interaction, 'Unknown command.', { ephemeral: true });
  }
}

async function handlePrefixCommandBody(message) {
  const prefix = getGuildPrefix(message.guild.id) || config.prefix;
  if (!message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/\s+/g);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  if (!canModerate(message.member)) {
    return message.reply('You do not have permission to use moderation commands.');
  }

  const userArg = message.mentions.users.first();
  const reason = args.slice(1).join(' ') || 'No reason provided';

  switch (command) {
    case 'ban':
      if (!userArg) return message.reply('Usage: !ban @user reason');
      return executeModeration({ guild: message.guild, user: message.author, member: message.member, reply: (payload) => message.reply(payload), followUp: () => null }, 'ban', userArg, reason);
    case 'kick':
      if (!userArg) return message.reply('Usage: !kick @user reason');
      return executeModeration({ guild: message.guild, user: message.author, member: message.member, reply: (payload) => message.reply(payload), followUp: () => null }, 'kick', userArg, reason);
    case 'mute': {
      if (!userArg) return message.reply('Usage: !mute @user 10m reason');
      const duration = args[1] || '10m';
      const muteReason = args.slice(2).join(' ') || reason;
      const ms = parseDuration(duration);
      if (!ms) return message.reply('Invalid mute duration. Use values like 10m, 2h, or 1d.');
      const member = message.guild.members.cache.get(userArg.id) || (await message.guild.members.fetch(userArg.id).catch(() => null));
      if (!member) return message.reply('User not found in this guild.');
      const allowed = await memberCanBeModerated(message.guild, message.member, member);
      if (!allowed) return message.reply('You cannot mute that user.');
      const untilEpoch = Date.now() + ms;
      await member.timeout(untilEpoch, muteReason).catch(() => null);
      setMute(message.guild.id, userArg.id, untilEpoch, muteReason);
      addModerationRecord({ guildId: message.guild.id, userId: userArg.id, moderatorId: message.author.id, action: 'mute', reason: `${muteReason} (${formatDuration(ms)})` });
      await logAction(message.guild, `**Mute**: <@${userArg.id}> by <@${message.author.id}> - ${muteReason} (${formatDuration(ms)})`);
      return message.reply(`Muted <@${userArg.id}> for ${formatDuration(ms)}.`);
    }
    case 'unmute': {
      if (!userArg) return message.reply('Usage: !unmute @user');
      const member = message.guild.members.cache.get(userArg.id) || (await message.guild.members.fetch(userArg.id).catch(() => null));
      if (!member) return message.reply('User not found in this guild.');
      await member.timeout(null).catch(() => null);
      clearMute(message.guild.id, userArg.id);
      addModerationRecord({ guildId: message.guild.id, userId: userArg.id, moderatorId: message.author.id, action: 'unmute', reason: 'Mute removed' });
      await logAction(message.guild, `**Unmute**: <@${userArg.id}> by <@${message.author.id}>`);
      return message.reply(`Unmuted <@${userArg.id}>.`);
    }
    case 'warn': {
      if (!userArg) return message.reply('Usage: !warn @user reason');
      addWarning({ guildId: message.guild.id, userId: userArg.id, moderatorId: message.author.id, reason });
      addModerationRecord({ guildId: message.guild.id, userId: userArg.id, moderatorId: message.author.id, action: 'warn', reason });
      await logAction(message.guild, `**Warn**: <@${userArg.id}> by <@${message.author.id}> - ${reason}`);
      return message.reply(`Warned <@${userArg.id}>: ${reason}`);
    }
    case 'setlog': {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('Usage: !setlog #channel');
      setGuildSetting(message.guild.id, 'log_channel_id', channel.id);
      return message.reply(`Moderation logs will be sent to <#${channel.id}>.`);
    }
    case 'setprefix': {
      const newPrefix = args[0];
      if (!newPrefix) return message.reply('Usage: !setprefix $');
      setGuildPrefix(message.guild.id, newPrefix);
      return message.reply(`Prefix updated to \`${newPrefix}\`.`);
    }
    case 'setupvoicehub': {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('Usage: !setupvoicehub #hub-channel');
      setGuildSetting(message.guild.id, 'voice_hub_channel_id', channel.id);
      return message.reply(`Voice hub set to <#${channel.id}>.`);
    }
    case 'settickettype': {
      const name = args[0];
      const category = message.mentions.channels.first();
      if (!name || !category) return message.reply('Usage: !settickettype general-support #category');
      addTicketType(message.guild.id, name, category.id, null);
      setGuildSetting(message.guild.id, 'ticket_category_id', category.id);
      return message.reply(`Ticket type \`${name}\` registered for <#${category.id}>.`);
    }
    case 'ticket': {
      const type = args[0];
      if (!type) return message.reply('Usage: !ticket general-support');
      const ticketType = listTicketTypes(message.guild.id).find((entry) => entry.name.toLowerCase() === type.toLowerCase());
      if (!ticketType) return message.reply(`Ticket type \`${type}\` not found.`);
      const category = message.guild.channels.cache.get(ticketType.category_id) || (await message.guild.channels.fetch(ticketType.category_id).catch(() => null));
      if (!category) return message.reply('The ticket category no longer exists.');
      const channelName = `${type.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${message.author.username.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 80);
      const channel = await message.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: [
          { id: message.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: message.author.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ],
      });
      if (ticketType.role_id) {
        channel.permissionOverwrites.edit(ticketType.role_id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      }
      return message.reply(`Ticket created: <#${channel.id}>`);
    }
    case 'roleembed': {
      const role = message.mentions.roles.first();
      if (!role) return message.reply('Usage: !roleembed @role');
      const button = new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('Role assignment').setDescription(`Click below to get the ${role.name} role.`);
      const createdMessage = await message.channel.send({ embeds: [embed], components: [row] });
      addRoleButton(message.guild.id, createdMessage.id, role.id, role.name);
      return message.reply(`Role button created for <@&${role.id}>.`);
    }
    default:
      return null;
  }
}

export async function handlePrefixCommand(message) {
  if (!message.guild || message.author.bot) return;
  return handlePrefixCommandBody(message);
}

export async function handleButtonInteraction(interaction) {
  if (!interaction.guild || !interaction.isButton()) return;
  const customId = interaction.customId;
  if (!customId.startsWith('role:')) return;

  const roleId = customId.replace('role:', '');
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: 'This role no longer exists.', ephemeral: true });

  const hasRole = interaction.member.roles.cache.has(roleId);
  if (hasRole) {
    await interaction.member.roles.remove(roleId);
    return interaction.reply({ content: `Removed the ${role.name} role.`, ephemeral: true });
  }

  await interaction.member.roles.add(roleId);
  return interaction.reply({ content: `Added the ${role.name} role.`, ephemeral: true });
}

export async function handleSelectMenuInteraction(interaction) {
  if (!interaction.isStringSelectMenu()) return;
  return interaction.reply({ content: 'Select menu interaction received.', ephemeral: true });
}

export async function handleJoinEvent(member) {
  const welcomeChannelId = getGuildSetting(member.guild.id, 'welcome_channel_id');
  const welcomeMessage = getGuildSetting(member.guild.id, 'welcome_message', 'Welcome {user} to {guild}! We are glad to have you here!');
  const autoRoleId = getGuildSetting(member.guild.id, 'auto_role_id');

  if (welcomeChannelId) {
    const channel = member.guild.channels.cache.get(welcomeChannelId) || (await member.guild.channels.fetch(welcomeChannelId).catch(() => null));
    if (channel) {
      const message = welcomeMessage
        .replace('{user}', `<@${member.id}>`)
        .replace('{guild}', member.guild.name);
      await channel.send(message).catch(() => null);
    }
  }

  if (autoRoleId) {
    await member.roles.add(autoRoleId).catch(() => null);
  }
}

export async function handleLeaveEvent(member) {
  const logChannelId = getGuildSetting(member.guild.id, 'log_channel_id');
  if (!logChannelId) return;
  const channel = member.guild.channels.cache.get(logChannelId) || (await member.guild.channels.fetch(logChannelId).catch(() => null));
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0xf04747).setTitle('Member left').setDescription(`<@${member.id}> left the server.`).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => null);
}

export async function handleMessageDelete(message) {
  if (!message.guild || message.author?.bot) return;
  const logChannelId = getGuildSetting(message.guild.id, 'log_channel_id');
  if (!logChannelId) return;
  const channel = message.guild.channels.cache.get(logChannelId) || (await message.guild.channels.fetch(logChannelId).catch(() => null));
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0xffa500).setTitle('Message deleted').setDescription(`A message from <@${message.author.id}> was deleted in <#${message.channel.id}>.`).addFields({ name: 'Content', value: message.content || 'No content available' }).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => null);
}

export async function handleMessageUpdate(oldMessage, newMessage) {
  if (!oldMessage.guild || oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
  const logChannelId = getGuildSetting(oldMessage.guild.id, 'log_channel_id');
  if (!logChannelId) return;
  const channel = oldMessage.guild.channels.cache.get(logChannelId) || (await oldMessage.guild.channels.fetch(logChannelId).catch(() => null));
  if (!channel) return;
  const embed = new EmbedBuilder().setColor(0x3498db).setTitle('Message edited').setDescription(`A message from <@${oldMessage.author.id}> was edited in <#${oldMessage.channel.id}>.`).addFields({ name: 'Before', value: oldMessage.content || 'No content available' }, { name: 'After', value: newMessage.content || 'No content available' }).setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => null);
}

export async function handleVoiceEvents(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const hubId = getGuildSetting(guild.id, 'voice_hub_channel_id');

  if (oldState.channelId && isTempVoiceChannel(oldState.channelId)) {
    const channel = oldState.guild.channels.cache.get(oldState.channelId);
    if (channel && channel.members.size === 0) {
      removeTempVoiceChannel(oldState.channelId);
      await channel.delete('Temporary voice channel emptied').catch(() => null);
    }
  }

  if (!newState.channelId || !hubId || newState.channelId !== hubId) return;
  const member = newState.member;
  if (!member) return;

  const channel = await guild.channels.create({
    name: `${member.displayName}'s room`,
    type: ChannelType.GuildVoice,
    parent: oldState.channel?.parentId || null,
    permissionOverwrites: [
      { id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel] },
      { id: member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak] },
    ],
  });

  addTempVoiceChannel(guild.id, channel.id, member.id);
  await member.voice.setChannel(channel).catch(() => null);
}

export async function handleMessageDeleteCommand(message) {
  await handleMessageDelete(message);
}

export async function handleMessageUpdateCommand(oldMessage, newMessage) {
  await handleMessageUpdate(oldMessage, newMessage);
}

export async function handleVoiceCommand(oldState, newState) {
  await handleVoiceEvents(oldState, newState);
}

export async function handleJoinCommand(member) {
  await handleJoinEvent(member);
}

export async function handleLeaveCommand(member) {
  await handleLeaveEvent(member);
}

export async function handlePrefixCommandCustom(message) {
  await handlePrefixCommand(message);
}

export { getWarnings, getMute };
