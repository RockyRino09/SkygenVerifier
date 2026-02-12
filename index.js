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

// Set to "global" for your request
const COMMAND_SCOPE = 'global';

// Set CLEAN_SLASH_COMMANDS=1 in .env for ONE run if you want a full wipe
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
   WEB SERVER (health)
========================= */
const app = express();
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
});

/* =========================
   STORAGE
========================= */
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}', 'utf8');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(d) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(d, null, 2), 'utf8');
}
function getGuildSettings(guildId) {
  const all = loadSettings();
  if (!all[guildId]) all[guildId] = {};
  return { all, g: all[guildId] };
}

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    // Needed for joinvc
    GatewayIntentBits.GuildVoiceStates,

    // Needed to delete messages in verify channel
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft Bedrock username')
    .addStringOption((o) =>
      o
        .setName('username')
        .setDescription('Your Minecraft Bedrock username')
        .setRequired(true)
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
    .setDescription('Join your current voice channel and stay 24/7'),
].map((c) => c.toJSON());

const voiceConnections = new Map(); // guildId -> connection

async function wipeAllCommands(rest) {
  console.log('🧹 Wiping ALL commands (global + guild)...');
  await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

  // wipe guild commands too (prevents duplicate /joinvc etc)
  for (const g of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
  }
  console.log('🧹 Wipe complete.');
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (CLEAN_SLASH_COMMANDS) {
    await wipeAllCommands(rest);
  }

  // GLOBAL registration
  await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
  console.log('✅ Registered GLOBAL slash commands');

  // Clear guild commands to avoid duplicates from older builds
  for (const g of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
  }
  console.log('✅ Cleared GUILD commands to prevent duplicates');
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('❌ Command registration failed:', e?.message || e);
  }
});

/* =========================
   VERIFY CHANNEL MODERATION
   (delete typing in verify channel)
========================= */
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const { g } = getGuildSettings(message.guild.id);

    if (g.verifyPaused) return;
    if (!g.verifyChannelId) return;
    if (message.channel.id !== g.verifyChannelId) return;

    // Delete message
    await message.delete().catch(() => {});

    // DM user
    await message.author
      .send(
        "⚠️ **Please don’t type in the verify channel.**\n\nUse:\n`/verify <Your Minecraft Bedrock username>`"
      )
      .catch(() => {});
  } catch (e) {
    console.error('messageCreate moderation error:', e?.message || e);
  }
});

/* =========================
   SAFE REPLY HELPERS
========================= */
async function safeReply(interaction, content) {
  try {
    if (interaction.replied) return;
    if (interaction.deferred) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch {
    // swallow
  }
}

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return safeReply(interaction, '❌ Commands only work in servers.');

  // Acknowledge ASAP to avoid Unknown interaction (10062)
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    // If this fails, the interaction is already expired or already acknowledged
    return;
  }

  try {
    const guildId = interaction.guild.id;

    // -------------------------
    // pauseverify
    // -------------------------
    if (interaction.commandName === 'pauseverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = true;
      saveSettings(all);
      return safeReply(interaction, '⏸️ Verification is now **paused** in this server.');
    }

    // -------------------------
    // resumeverify
    // -------------------------
    if (interaction.commandName === 'resumeverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = false;
      saveSettings(all);
      return safeReply(interaction, '▶️ Verification is now **resumed** in this server.');
    }

    // -------------------------
    // setverifychannel
    // -------------------------
    if (interaction.commandName === 'setverifychannel') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyChannelId = interaction.channel.id;
      g.verifyPaused = false;
      saveSettings(all);
      return safeReply(interaction, '✅ This channel is now the **verify channel**.');
    }

    // -------------------------
    // verify
    // -------------------------
    if (interaction.commandName === 'verify') {
      const { all, g } = getGuildSettings(guildId);

      if (g.verifyPaused) {
        return safeReply(interaction, '⏸️ Verification is currently **paused** in this server.');
      }
      if (!g.verifyChannelId) {
        return safeReply(interaction, '❌ Verify channel not set. Use **/setverifychannel** first.');
      }
      if (interaction.channel.id !== g.verifyChannelId) {
        return safeReply(interaction, '❌ Use **/verify** in the verify channel.');
      }

      const username = interaction.options.getString('username', true);
      const member = interaction.member;

      // Ensure role exists
      let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        try {
          role = await interaction.guild.roles.create({
            name: VERIFIED_ROLE_NAME,
            color: 0x00ff00,
            reason: 'Auto-created by RhinoVerifier',
          });
        } catch {
          return safeReply(
            interaction,
            '❌ I couldn’t create the Verified role. I need **Manage Roles** permission.'
          );
        }
      }

      // Nickname logic (server owner cannot be nick-changed by bots)
      let nickMsg = '';
      if (interaction.guild.ownerId === member.id) {
        nickMsg = 'ℹ️ I **cannot change** the server owner’s nickname, but you are still verified.';
      } else {
        try {
          await member.setNickname(username);
          nickMsg = '✅ Nickname updated.';
        } catch {
          nickMsg = '⚠️ Could not change nickname (check role order + Manage Nicknames).';
        }
      }

      // Add role
      try {
        await member.roles.add(role);
      } catch {
        return safeReply(
          interaction,
          `❌ I couldn’t add **${VERIFIED_ROLE_NAME}**. Move my role above it and ensure **Manage Roles** is enabled.`
        );
      }

      saveSettings(all);
      return safeReply(interaction, `✅ Verified as **${username}**\n${nickMsg}`);
    }

    // -------------------------
    // joinvc
    // -------------------------
    if (interaction.commandName === 'joinvc') {
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        return safeReply(interaction, '❌ Join a voice channel first, then run **/joinvc**.');
      }

      // Disconnect old connection in this guild if exists
      const old = voiceConnections.get(channel.guild.id);
      if (old) {
        try { old.destroy(); } catch {}
        voiceConnections.delete(channel.guild.id);
      }

      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      voiceConnections.set(channel.guild.id, conn);

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        try { conn.destroy(); } catch {}
        voiceConnections.delete(channel.guild.id);
        return safeReply(
          interaction,
          '❌ Could not connect to that voice channel (try a normal voice channel, not a stage).'
        );
      }

      return safeReply(interaction, `✅ Joined **${channel.name}** and staying 24/7.`);
    }

    return safeReply(interaction, '❌ Unknown command.');
  } catch (e) {
    console.error('interaction error:', e?.message || e);
    return safeReply(interaction, '❌ Command failed. Check PM2 logs.');
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(TOKEN);