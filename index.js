require(‘dotenv’).config();

const fs = require(‘fs’);
const path = require(‘path’);
const express = require(‘express’);

const {
Client,
GatewayIntentBits,
REST,
Routes,
SlashCommandBuilder,
PermissionsBitField,
} = require(‘discord.js’);

const {
joinVoiceChannel,
entersState,
VoiceConnectionStatus,
} = require(’@discordjs/voice’);

/* =========================
CONFIG
========================= */
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID;
const PORT = Number(process.env.PORT || 8000);
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || ‘global’).toLowerCase(); // global|guild
const CLEAN_SLASH_COMMANDS = process.env.CLEAN_SLASH_COMMANDS === ‘1’;

const VERIFIED_ROLE_NAME = ‘Verified’;

if (!TOKEN) {
console.error(‘❌ DISCORD_BOT_TOKEN missing’);
process.exit(1);
}
if (!APP_ID) {
console.error(‘❌ APP_ID missing’);
process.exit(1);
}

/* =========================
WEB SERVER (health check)
========================= */
const app = express();
app.get(’/’, (_, res) => res.status(200).send(‘Bot is alive’));
app.listen(PORT, ‘0.0.0.0’, () => console.log(`🌐 Web server listening on port ${PORT}`));

/* =========================
STORAGE
========================= */
const DATA_DIR = path.join(__dirname, ‘data’);
const SETTINGS_FILE = path.join(DATA_DIR, ‘settings.json’);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, ‘{}’, ‘utf8’);

function loadSettings() {
try {
return JSON.parse(fs.readFileSync(SETTINGS_FILE, ‘utf8’));
} catch {
return {};
}
}
function saveSettings(all) {
fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), ‘utf8’);
}
function getGuildSettings(guildId) {
const all = loadSettings();
all[guildId] ??= { verifyPaused: false, verifyChannelId: null };
return { all, g: all[guildId] };
}

/* =========================
DISCORD CLIENT
========================= */
const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildVoiceStates,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
],
});

process.on(‘unhandledRejection’, (e) => console.error(‘unhandledRejection:’, e));
process.on(‘uncaughtException’, (e) => console.error(‘uncaughtException:’, e));

/* =========================
SLASH COMMANDS
========================= */
const commands = [
new SlashCommandBuilder()
.setName(‘verify’)
.setDescription(‘Verify your Minecraft Bedrock username’)
.addStringOption((o) =>
o
.setName(‘username’)
.setDescription(‘Your Minecraft Bedrock username’)
.setRequired(true)
),

new SlashCommandBuilder()
.setName(‘setverifychannel’)
.setDescription(‘Set the channel where /verify can be used’)
.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

new SlashCommandBuilder()
.setName(‘pauseverify’)
.setDescription(‘Pause verification in this server’)
.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

new SlashCommandBuilder()
.setName(‘resumeverify’)
.setDescription(‘Resume verification in this server’)
.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

new SlashCommandBuilder()
.setName(‘joinvc’)
.setDescription(‘Join your current voice channel and stay connected 24/7’),
].map((c) => c.toJSON());

/* =========================
VOICE CONNECTIONS
Map<guildId, { connection, channelId, reconnectTimer }>
========================= */
const voiceConnections = new Map();

/**

- Creates a persistent voice connection for a guild.
- Automatically reconnects on disconnect.
- 
- @param {import(‘discord.js’).VoiceChannel} channel
- @returns {import(’@discordjs/voice’).VoiceConnection}
  */
  function createPersistentConnection(channel) {
  const guildId = channel.guild.id;

console.log(`🔊 Connecting to voice channel "${channel.name}" in guild ${guildId}...`);

const conn = joinVoiceChannel({
channelId: channel.id,
guildId: channel.guild.id,
adapterCreator: channel.guild.voiceAdapterCreator,
selfDeaf: true,
selfMute: true,
});

// ── State change logging ──────────────────────────────────────────────────
conn.on(‘stateChange’, (oldState, newState) => {
console.log(
`🔊 [Guild ${guildId}] Voice state: ${oldState.status} → ${newState.status}`
);
});

// ── Ready ─────────────────────────────────────────────────────────────────
conn.on(VoiceConnectionStatus.Ready, () => {
console.log(`✅ [Guild ${guildId}] Voice connection is Ready in "${channel.name}"`);

```
// Clear any pending reconnect timer
const entry = voiceConnections.get(guildId);
if (entry?.reconnectTimer) {
  clearTimeout(entry.reconnectTimer);
  entry.reconnectTimer = null;
}
```

});

// ── Disconnected ──────────────────────────────────────────────────────────
conn.on(VoiceConnectionStatus.Disconnected, async () => {
console.warn(`⚠️ [Guild ${guildId}] Voice disconnected. Attempting to recover...`);

```
try {
  /*
   * First try: wait up to 5 s for Discord to move the connection back to
   * Signalling or Connecting on its own (handles brief network blips /
   * Discord-side reconnects without tearing down the UDP session).
   */
  await Promise.race([
    entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
    entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
  ]);
  console.log(`🔁 [Guild ${guildId}] Recovery: entered Signalling/Connecting, waiting for Ready...`);
} catch {
  /*
   * Second try: the connection is truly gone. Destroy it and schedule a
   * full reconnect after 5 s. We keep the entry in voiceConnections so
   * the reconnect timer reference is preserved.
   */
  console.warn(`❌ [Guild ${guildId}] Could not recover — scheduling full reconnect in 5 s...`);

  try { conn.destroy(); } catch {}

  const entry = voiceConnections.get(guildId);
  if (entry) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);

    entry.reconnectTimer = setTimeout(async () => {
      console.log(`🔁 [Guild ${guildId}] Attempting full reconnect to "${channel.name}"...`);
      try {
        // Re-fetch the channel to ensure it's still valid
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          console.error(`❌ [Guild ${guildId}] Guild no longer in cache, aborting reconnect.`);
          voiceConnections.delete(guildId);
          return;
        }

        const freshChannel = guild.channels.cache.get(channel.id);
        if (!freshChannel) {
          console.error(`❌ [Guild ${guildId}] Channel ${channel.id} no longer exists, aborting reconnect.`);
          voiceConnections.delete(guildId);
          return;
        }

        const newConn = createPersistentConnection(freshChannel);
        entry.connection = newConn;
        entry.reconnectTimer = null;

        // Wait for the new connection to be Ready before declaring success
        await entersState(newConn, VoiceConnectionStatus.Ready, 20_000);
        console.log(`✅ [Guild ${guildId}] Full reconnect successful.`);
      } catch (e) {
        console.error(`❌ [Guild ${guildId}] Full reconnect failed:`, e?.message || e);
        // Will retry next time a Disconnected event fires (the new conn also has this handler)
      }
    }, 5_000);
  }
}
```

});

// ── Destroyed ─────────────────────────────────────────────────────────────
conn.on(VoiceConnectionStatus.Destroyed, () => {
console.log(`🗑️ [Guild ${guildId}] Voice connection destroyed.`);
// Only clean up the map entry if it still holds this same connection object
const entry = voiceConnections.get(guildId);
if (entry?.connection === conn) {
if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
voiceConnections.delete(guildId);
}
});

// ── Generic error ─────────────────────────────────────────────────────────
conn.on(‘error’, (e) => {
console.error(`❌ [Guild ${guildId}] Voice connection error:`, e?.message || e);
});

return conn;
}

/* =========================
COMMAND REGISTRATION
========================= */
async function wipeCommands(rest) {
console.log(‘🧹 Cleaning old commands…’);
await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
for (const g of client.guilds.cache.values()) {
await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
}
console.log(‘🧹 Done.’);
}

async function registerCommands() {
const rest = new REST({ version: ‘10’ }).setToken(TOKEN);

if (CLEAN_SLASH_COMMANDS) {
await wipeCommands(rest);
}

if (COMMAND_SCOPE === ‘guild’) {
await rest.put(Routes.applicationCommands(APP_ID), { body: [] }); // prevent global duplicates
for (const g of client.guilds.cache.values()) {
await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: commands });
}
console.log(`✅ Registered GUILD commands for ${client.guilds.cache.size} server(s)`);
} else {
await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
console.log(‘✅ Registered GLOBAL commands (may take up to 1 hour to propagate)’);
}
}

client.on(‘guildCreate’, async (guild) => {
if (COMMAND_SCOPE !== ‘guild’) return;
try {
const rest = new REST({ version: ‘10’ }).setToken(TOKEN);
await rest.put(Routes.applicationGuildCommands(APP_ID, guild.id), { body: commands });
console.log(`✅ Registered commands in new guild: ${guild.name} (${guild.id})`);
} catch (e) {
console.error(‘❌ guildCreate command registration failed:’, e?.message || e);
}
});

/* =========================
READY (fires once)
========================= */
let didReady = false;
client.once(‘ready’, async () => {
if (didReady) return;
didReady = true;

console.log(`✅ Logged in as ${client.user.tag}`);
console.log(`📡 Connected to ${client.guilds.cache.size} guild(s)`);

try {
await registerCommands();
} catch (e) {
console.error(‘❌ Slash command registration failed:’, e?.message || e);
}
});

/* =========================
DELETE NON-SLASH MESSAGES IN VERIFY CHANNEL
========================= */
client.on(‘messageCreate’, async (message) => {
if (!message.guild) return;
if (message.author.bot) return;

const settings = loadSettings();
const g = settings[message.guild.id];
if (!g?.verifyChannelId) return;
if (g.verifyPaused) return;
if (message.channel.id !== g.verifyChannelId) return;

try {
await message.delete();
} catch {
// Missing permissions — silently ignore
}

await message.author
.send(‘⚠️ **Do not type in the verify channel.**\n\nUse the slash command instead:\n`/verify <Your Minecraft Bedrock username>`’)
.catch(() => {});
});

/* =========================
INTERACTIONS
========================= */
client.on(‘interactionCreate’, async (interaction) => {
if (!interaction.isChatInputCommand()) return;
if (!interaction.inGuild()) return;

// Defer immediately to avoid Unknown Interaction (10062)
try {
await interaction.deferReply({ ephemeral: true });
} catch {
return; // Interaction already expired — nothing we can do
}

const guildId = interaction.guild.id;

try {
// ── /pauseverify ──────────────────────────────────────────────────────
if (interaction.commandName === ‘pauseverify’) {
const { all, g } = getGuildSettings(guildId);
g.verifyPaused = true;
saveSettings(all);
return interaction.editReply(‘⏸️ Verification is now **paused** in this server.’);
}

```
// ── /resumeverify ─────────────────────────────────────────────────────
if (interaction.commandName === 'resumeverify') {
  const { all, g } = getGuildSettings(guildId);
  g.verifyPaused = false;
  saveSettings(all);
  return interaction.editReply('▶️ Verification is now **resumed** in this server.');
}

// ── /setverifychannel ─────────────────────────────────────────────────
if (interaction.commandName === 'setverifychannel') {
  const { all, g } = getGuildSettings(guildId);
  g.verifyChannelId = interaction.channel.id;
  g.verifyPaused = false;
  saveSettings(all);
  return interaction.editReply(`✅ Verify channel set to <#${interaction.channel.id}>.`);
}

// ── /verify ───────────────────────────────────────────────────────────
if (interaction.commandName === 'verify') {
  const { all, g } = getGuildSettings(guildId);

  if (g.verifyPaused) {
    return interaction.editReply('⏸️ Verification is currently **paused**. Ask an admin to resume it.');
  }
  if (!g.verifyChannelId) {
    return interaction.editReply('❌ No verify channel set. Ask an admin to run `/setverifychannel` first.');
  }
  if (interaction.channel.id !== g.verifyChannelId) {
    return interaction.editReply(`❌ Please use \`/verify\` in <#${g.verifyChannelId}>.`);
  }

  const username = interaction.options.getString('username', true);
  const member = await interaction.guild.members.fetch(interaction.user.id);

  // Get or create the Verified role
  let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
  if (!role) {
    try {
      role = await interaction.guild.roles.create({
        name: VERIFIED_ROLE_NAME,
        color: 0x00ff00,
        reason: 'Auto-created by SkygenVerifier',
      });
    } catch {
      return interaction.editReply('❌ I could not create the **Verified** role. Please create it manually and ensure I have **Manage Roles**.');
    }
  }

  // Add role
  try {
    await member.roles.add(role);
  } catch {
    return interaction.editReply(
      '❌ I can\'t add the **Verified** role. Make sure my role is positioned **above** the Verified role in Server Settings → Roles, and that I have **Manage Roles**.'
    );
  }

  // Set nickname (skip for server owner — bots cannot change owner nicknames)
  let nickMsg;
  if (interaction.guild.ownerId === member.id) {
    nickMsg = 'ℹ️ You are the server owner — I can\'t change your nickname.';
  } else {
    try {
      await member.setNickname(username);
      nickMsg = `✅ Nickname set to **${username}**.`;
    } catch {
      nickMsg = '⚠️ Could not change your nickname. Check my role order and **Manage Nicknames** permission.';
    }
  }

  saveSettings(all);
  return interaction.editReply(`✅ You are now verified as **${username}**!\n${nickMsg}`);
}

// ── /joinvc ───────────────────────────────────────────────────────────
if (interaction.commandName === 'joinvc') {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice?.channel;

  if (!channel) {
    return interaction.editReply('❌ You are not in a voice channel. Join one first, then run `/joinvc`.');
  }

  // Destroy any existing connection for this guild
  const existing = voiceConnections.get(guildId);
  if (existing) {
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    try { existing.connection.destroy(); } catch {}
    voiceConnections.delete(guildId);
  }

  // Create the persistent connection
  const conn = createPersistentConnection(channel);

  // Store entry BEFORE awaiting Ready so the Disconnected handler can find it
  voiceConnections.set(guildId, { connection: conn, channelId: channel.id, reconnectTimer: null });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    // Clean up on failure
    try { conn.destroy(); } catch {}
    voiceConnections.delete(guildId);
    return interaction.editReply(
      '❌ Could not connect to voice.\n\n**Most likely cause on Oracle Cloud:** UDP ports 50000–65535 are blocked by your Security List or Network Security Group. Open those ports for inbound UDP traffic and also run:\n```\nsudo iptables -I INPUT -p udp --dport 50000:65535 -j ACCEPT\nsudo netfilter-persistent save\n```'
    );
  }

  return interaction.editReply(`✅ Joined **${channel.name}** and will stay connected 24/7.`);
}

// ── Unknown command fallback ───────────────────────────────────────────
return interaction.editReply('❌ Unknown command.');
```

} catch (e) {
console.error(‘❌ Interaction handler error:’, e);
try {
return interaction.editReply(‘❌ An error occurred. Check `pm2 logs skygenverifier` for details.’);
} catch {}
}
});

/* =========================
LOGIN
========================= */
console.log(‘🚀 Logging in…’);
client.login(TOKEN);