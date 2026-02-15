require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  MessageFlags,
} = require('discord.js');

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

/* =========================
   CONFIG
========================= */
const VERIFIED_ROLE_NAME = 'Verified';
const PORT = Number(process.env.PORT || 8000);

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID;

// global = works everywhere (can take a while to show)
// guild  = instant, per server
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'global').toLowerCase();

// set CLEAN_SLASH_COMMANDS=1 for ONE run to wipe duplicates, then set back to 0
const CLEAN_SLASH_COMMANDS = process.env.CLEAN_SLASH_COMMANDS === '1';

if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}
if (!APP_ID) {
  console.error('❌ APP_ID missing');
  process.exit(1);
}

/* =========================
   WEB SERVER
========================= */
const app = express();
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on port ${PORT}`));

/* =========================
   STORAGE
========================= */
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}', 'utf8');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(all) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf8');
}
function getGuildSettings(guildId) {
  const all = loadSettings();
  if (!all[guildId]) all[guildId] = { verifyPaused: false, verifyChannelId: null };
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

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

/* =========================
   SLASH COMMANDS
========================= */
const commandDefs = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft Bedrock username')
    .addStringOption((o) =>
      o.setName('username').setDescription('Your Minecraft Bedrock username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set the channel where /verify can be used')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('pauseverify')
    .setDescription('Pause verification in this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('resumeverify')
    .setDescription('Resume verification in this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('joinvc')
    .setDescription('Join your current voice channel and stay connected 24/7'),
];

const commandsJSON = commandDefs.map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (CLEAN_SLASH_COMMANDS) {
    console.log('🧹 Wiping old slash commands (global + guild)...');
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
    }
    console.log('🧹 Wipe complete.');
  }

  if (COMMAND_SCOPE === 'guild') {
    // prevent global duplicates
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: commandsJSON });
    }
    console.log(`✅ Registered GUILD slash commands for ${client.guilds.cache.size} guild(s)`);
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commandsJSON });
    console.log('✅ Registered GLOBAL slash commands');
  }
}

// if you use guild scope, auto-register when added to new server
client.on('guildCreate', async (guild) => {
  if (COMMAND_SCOPE !== 'guild') return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(APP_ID, guild.id), { body: commandsJSON });
    console.log(`✅ Registered commands in new guild: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error('❌ guildCreate registration failed:', e?.message || e);
  }
});

/* =========================
   READY (GUARDED)
========================= */
let didReady = false;
client.once('ready', async () => {
  if (didReady) return;
  didReady = true;

  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('❌ Slash command registration failed:', e?.message || e);
  }
});

/* =========================
   VERIFY CHANNEL MESSAGE DELETE
========================= */
client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const settings = loadSettings();
  const g = settings[message.guild.id];
  if (!g?.verifyChannelId) return;
  if (g.verifyPaused) return;
  if (message.channel.id !== g.verifyChannelId) return;

  try {
    await message.delete();
    await message.author.send(
      '⚠️ **Do not type in the verify channel**\n\nUse:\n`/verify <Your Minecraft Bedrock username>`'
    ).catch(() => {});
  } catch {}
});

/* =========================
   VOICE (PERSISTENT)
========================= */
const voiceConnections = new Map(); // guildId -> { connection, channelId }

function connectVoice(channel) {
  const guildId = channel.guild.id;

  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
  });

  conn.on('stateChange', (oldS, newS) => {
    console.log(`🔊 [${guildId}] ${oldS.status} -> ${newS.status}`);
  });

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // brief network blip / region move
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // if it gets here, it’s trying to reconnect
      return;
    } catch {
      // full reconnect
      try { conn.destroy(); } catch {}
      const entry = voiceConnections.get(guildId);
      if (!entry) return;

      const fresh = channel.guild.channels.cache.get(entry.channelId);
      if (!fresh || !fresh.isVoiceBased?.()) {
        voiceConnections.delete(guildId);
        return;
      }

      const newConn = connectVoice(fresh);
      voiceConnections.set(guildId, { connection: newConn, channelId: entry.channelId });
    }
  });

  conn.on(VoiceConnectionStatus.Destroyed, () => {
    const entry = voiceConnections.get(guildId);
    if (entry?.connection === conn) voiceConnections.delete(guildId);
  });

  return conn;
}

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    try {
      return await interaction.reply({
        content: '❌ Commands only work in servers.',
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      return;
    }
  }

  // IMPORTANT: ack fast so it never sits on “thinking”
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch {
    return;
  }

  const guildId = interaction.guild.id;

  try {
    if (interaction.commandName === 'pauseverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = true;
      saveSettings(all);
      return await interaction.editReply('⏸️ Verification is now **paused** in this server.');
    }

    if (interaction.commandName === 'resumeverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = false;
      saveSettings(all);
      return await interaction.editReply('▶️ Verification is now **resumed** in this server.');
    }

    if (interaction.commandName === 'setverifychannel') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyChannelId = interaction.channel.id;
      g.verifyPaused = false;
      saveSettings(all);
      return await interaction.editReply('✅ Verify channel set.');
    }

    if (interaction.commandName === 'verify') {
      const { all, g } = getGuildSettings(guildId);

      if (g.verifyPaused) {
        return await interaction.editReply('⏸️ Verification is currently **paused** in this server.');
      }
      if (!g.verifyChannelId) {
        return await interaction.editReply('❌ Verify channel not set. Use `/setverifychannel` first.');
      }
      if (interaction.channel.id !== g.verifyChannelId) {
        return await interaction.editReply('❌ Use `/verify` in the verify channel.');
      }

      const username = interaction.options.getString('username', true);
      const member = await interaction.guild.members.fetch(interaction.user.id);

      let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00ff00,
          reason: 'Auto-created by SkygenVerifier',
        });
      }

      // nickname
      let nickMsg;
      if (interaction.guild.ownerId === member.id) {
        nickMsg = 'ℹ️ You are the server owner — bots cannot change your nickname.';
      } else {
        try {
          await member.setNickname(username);
          nickMsg = '✅ Nickname updated.';
        } catch {
          nickMsg = '⚠️ Could not change nickname (role order / Manage Nicknames).';
        }
      }

      // role
      try {
        await member.roles.add(role);
      } catch {
        return await interaction.editReply(
          '❌ I can’t add the Verified role. Put my bot role above **Verified** and give me **Manage Roles**.'
        );
      }

      saveSettings(all);
      return await interaction.editReply(`✅ Verified as **${username}**\n${nickMsg}`);
    }

    if (interaction.commandName === 'joinvc') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice?.channel;

      if (!channel) {
        return await interaction.editReply('❌ Join a voice channel first, then run `/joinvc`.');
      }

      // clean old
      const existing = voiceConnections.get(guildId);
      if (existing?.connection) {
        try { existing.connection.destroy(); } catch {}
        voiceConnections.delete(guildId);
      }

      const conn = connectVoice(channel);
      voiceConnections.set(guildId, { connection: conn, channelId: channel.id });

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 25_000);
      } catch {
        try { conn.destroy(); } catch {}
        voiceConnections.delete(guildId);
        return await interaction.editReply(
          '❌ Could not connect to voice. On Oracle this is usually UDP being blocked (50000–65535).'
        );
      }

      return await interaction.editReply(`✅ Joined **${channel.name}** and staying 24/7.`);
    }

    return await interaction.editReply('❌ Unknown command.');
  } catch (e) {
    console.error('interaction error:', e);
    try {
      await interaction.editReply('❌ Command failed. Check PM2 logs.');
    } catch {}
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(TOKEN);