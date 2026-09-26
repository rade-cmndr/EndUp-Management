import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'data/endup.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT,
    prefix TEXT DEFAULT '!',
    welcome_channel_id TEXT,
    welcome_message TEXT DEFAULT 'Welcome {user} to {guild}! We are glad to have you here!',
    auto_role_id TEXT,
    verify_channel_id TEXT,
    verify_role_id TEXT,
    alt_check_enabled INTEGER DEFAULT 1,
    alt_min_days INTEGER DEFAULT 7,
    voice_hub_channel_id TEXT
  );

  CREATE TABLE IF NOT EXISTS moderation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    moderator_id TEXT,
    action TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    moderator_id TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mutes (
    guild_id TEXT,
    user_id TEXT,
    until_epoch INTEGER,
    reason TEXT,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS ticket_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    name TEXT,
    category_id TEXT,
    role_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS temp_voice_channels (
    guild_id TEXT,
    channel_id TEXT PRIMARY KEY,
    owner_id TEXT
  );

  CREATE TABLE IF NOT EXISTS role_buttons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    message_id TEXT,
    role_id TEXT,
    label TEXT
  );
`);

export function ensureGuildSettings(guildId) {
  const row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId);
  if (!row) {
    db.prepare('INSERT INTO guild_settings (guild_id, prefix) VALUES (?, ?)').run(guildId, '!');
    return { guild_id: guildId, prefix: '!', log_channel_id: null, welcome_channel_id: null, welcome_message: 'Welcome {user} to {guild}! We are glad to have you here!', auto_role_id: null, verify_channel_id: null, verify_role_id: null, alt_check_enabled: 1, alt_min_days: 7, voice_hub_channel_id: null };
  }
  return row;
}

export function getGuildSetting(guildId, key, fallback = null) {
  const row = ensureGuildSettings(guildId);
  return row[key] ?? fallback;
}

export function setGuildSetting(guildId, key, value) {
  const current = ensureGuildSettings(guildId);
  const columns = Object.keys(current)
    .filter((column) => column !== 'guild_id')
    .join(', ');

  const sql = `UPDATE guild_settings SET ${key} = ? WHERE guild_id = ?`;
  db.prepare(sql).run(value, guildId);
  return true;
}

export function getGuildPrefix(guildId) {
  return getGuildSetting(guildId, 'prefix', '!');
}

export function setGuildPrefix(guildId, prefix) {
  setGuildSetting(guildId, 'prefix', prefix);
}

export function addModerationRecord({ guildId, userId, moderatorId, action, reason }) {
  db.prepare(`
    INSERT INTO moderation_history (guild_id, user_id, moderator_id, action, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(guildId, userId, moderatorId, action, reason || 'No reason provided');
}

export function addWarning({ guildId, userId, moderatorId, reason }) {
  db.prepare(`
    INSERT INTO warnings (guild_id, user_id, moderator_id, reason)
    VALUES (?, ?, ?, ?)
  `).run(guildId, userId, moderatorId, reason || 'No reason provided');
}

export function getWarnings(guildId, userId) {
  return db.prepare(`
    SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC
  `).all(guildId, userId);
}

export function setMute(guildId, userId, untilEpoch, reason) {
  db.prepare(`
    INSERT INTO mutes (guild_id, user_id, until_epoch, reason)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET until_epoch = excluded.until_epoch, reason = excluded.reason
  `).run(guildId, userId, untilEpoch, reason || 'No reason provided');
}

export function clearMute(guildId, userId) {
  db.prepare('DELETE FROM mutes WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

export function getMute(guildId, userId) {
  return db.prepare('SELECT * FROM mutes WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

export function addTicketType(guildId, name, categoryId, roleId = null) {
  db.prepare(`
    INSERT INTO ticket_types (guild_id, name, category_id, role_id)
    VALUES (?, ?, ?, ?)
  `).run(guildId, name, categoryId, roleId || null);
}

export function listTicketTypes(guildId) {
  return db.prepare('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY name ASC').all(guildId);
}

export function getTicketTypesByGuild(guildId) {
  return listTicketTypes(guildId);
}

export function addTempVoiceChannel(guildId, channelId, ownerId) {
  db.prepare(`INSERT INTO temp_voice_channels (guild_id, channel_id, owner_id) VALUES (?, ?, ?)`).run(guildId, channelId, ownerId);
}

export function removeTempVoiceChannel(channelId) {
  db.prepare('DELETE FROM temp_voice_channels WHERE channel_id = ?').run(channelId);
}

export function isTempVoiceChannel(channelId) {
  return !!db.prepare('SELECT 1 FROM temp_voice_channels WHERE channel_id = ?').get(channelId);
}

export function addRoleButton(guildId, messageId, roleId, label) {
  db.prepare(`
    INSERT INTO role_buttons (guild_id, message_id, role_id, label)
    VALUES (?, ?, ?, ?)
  `).run(guildId, messageId, roleId, label);
}

export function getRoleButtonData(guildId, messageId) {
  return db.prepare('SELECT * FROM role_buttons WHERE guild_id = ? AND message_id = ?').all(guildId, messageId);
}

export default db;
