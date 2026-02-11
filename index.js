require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require('discord.js');

/* =========================
   CONFIG
========================= */
const VERIFIED_ROLE_NAME = 'Verified';
const PORT = process.env.PORT || 8000;
const APP_URL = process.env.APP_URL;

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
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
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
};
const saveSettings = (data) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

process.on('unhandledRejection', console.error);

/* =========================
   COMMANDS (single source of truth)
========================= */
const COMMAND_BUILDERS = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set verification channel (run inside the channel)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('pauseverify')
    .setDescription('Pause verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('resumeverify')
    .setDescription('Resume verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('joinvc')
    .setDescription('Make the bot join and stay in your VC 24/7'),

  // Admin-only utility to fix duplicates / stale commands
  new SlashCommandBuilder()
    .setName('synccommands')
    .setDescription('Admin: re-sync slash commands (fix duplicates)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
];

const COMMANDS_JSON = COMMAND_BUILDERS.map(c => c.toJSON());

async function registerGlobalCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS_JSON });
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await registerGlobalCommands();
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }

  if (APP_URL) {
    setInterval(() => axios.get(APP_URL).catch(() => {}), 5 * 60 * 1000);
    console.log(`💓 Heartbeat active → ${APP_URL}`);
  }
});

/* =========================
   VERIFY CHANNEL MODERATION
========================= */
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const settings = loadSettings();
  const g = settings[message.guild.id];
  if (!g?.verifyChannelId || g.paused) return;
  if (message.channel.id !== g.verifyChannelId) return;

  await message.delete().catch(() => {});
  message.author.send('⚠️ Do not type in the verify channel.\nUse `/verify <username>` instead.').catch(() => {});
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };

  try {
    // --- Admin: fix duplicates and stale commands ---
    if (interaction.commandName === 'synccommands') {
      await interaction.deferReply({ ephemeral: true });

      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

      // 1) Clear global commands
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

      // 2) Clear this guild’s guild-commands too (kills old per-guild ones if you ever used them)
      await rest.put(Routes.applicationGuildCommands(client.user.id, interaction.guild.id), { body: [] });

      // 3) Re-register globals
      await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS_JSON });

      return interaction.editReply('✅ Commands re-synced. Wait ~1 minute, then re-open Discord or type `/` again.');
    }

    if (interaction.commandName === 'setverifychannel') {
      settings[gid].verifyChannelId = interaction.channel.id;
      settings[gid].paused = false;
      saveSettings(settings);
      return interaction.reply({ content: '✅ Verify channel set', ephemeral: true });
    }

    if (interaction.commandName === 'pauseverify') {
      settings[gid].paused = true;
      saveSettings(settings);
      return interaction.reply({ content: '⏸ Verification paused', ephemeral: true });
    }

    if (interaction.commandName === 'resumeverify') {
      settings[gid].paused = false;
      saveSettings(settings);
      return interaction.reply({ content: '▶️ Verification resumed', ephemeral: true });
    }

    if (interaction.commandName === 'verify') {
      if (!settings[gid].verifyChannelId) {
        return interaction.reply({ content: '❌ Verification not set up. Run `/setverifychannel` in your verify channel.', ephemeral: true });
      }
      if (settings[gid].paused) {
        return interaction.reply({ content: '⏸ Verification is paused.', ephemeral: true });
      }

      const username = interaction.options.getString('username');
      const member = interaction.member;

      let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
      if (!role) role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });

      // Role add should work if hierarchy is correct
      await member.roles.add(role);

      // Owner nickname: do NOT pretend it changed
      if (interaction.guild.ownerId === member.id) {
        return interaction.reply({
          content: `✅ Verified as **${username}**.\nℹ️ I can’t change the **server owner’s** nickname on Discord, so please change it manually in Server Settings → Members.`,
          ephemeral: true
        });
      }

      // Normal nickname change, but report if it fails
      try {
        await member.setNickname(username);
        return interaction.reply({ content: `✅ Verified as **${username}** (nickname updated)`, ephemeral: true });
      } catch {
        return interaction.reply({
          content: `✅ Verified as **${username}** (role added)\n⚠️ I couldn’t change your nickname. Make sure I have **Manage Nicknames** and my role is above your role.`,
          ephemeral: true
        });
      }
    }

    if (interaction.commandName === 'joinvc') {
      // Defer so it never gets stuck on "thinking" if Discord is slow
      await interaction.deferReply({ ephemeral: true });

      const channel = interaction.member.voice?.channel;
      if (!channel) return interaction.editReply('❌ Join a voice channel first.');

      // If already connected, don’t create a second connection
      const existing = getVoiceConnection(channel.guild.id);
      if (!existing) {
        joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: true
        });
      }

      return interaction.editReply(`🔊 Joined **${channel.name}** and will stay 24/7.`);
    }

  } catch (e) {
    console.error(e);
    // Best-effort error reply without double-responding
    if (interaction.deferred) return interaction.editReply('❌ Something went wrong.');
    if (!interaction.replied) return interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
