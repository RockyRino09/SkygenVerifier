require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const axios = require('axios');

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
   WEB SERVER + HEARTBEAT
========================= */
const app = express();
app.get('/', (_, res) => res.send('Bot is alive'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
  
  if (APP_URL) {
    console.log(`💓 Heartbeat enabled → ${APP_URL}`);
    setInterval(async () => {
      try { await axios.get(APP_URL); console.log('💓 Heartbeat ping OK'); }
      catch { console.warn('⚠️ Heartbeat ping failed'); }
    }, 5 * 60 * 1000); // ping every 5 mins
  } else console.warn('⚠️ APP_URL not set — bot may sleep');
});

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
const saveSettings = data => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates]
});

process.on('unhandledRejection', console.error);

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(o => o.setName('username').setDescription('Minecraft username').setRequired(true)),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set verify channel')
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
    .setDescription('Bot joins your voice channel and stays there 24/7')
].map(c => c.toJSON());

/* =========================
   READY + REGISTER COMMANDS
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
});

/* =========================
   INTERACTION HANDLER
========================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: true });

  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };
  
  // --- Verify logic ---
  if (interaction.commandName === 'setverifychannel') {
    settings[gid].verifyChannelId = interaction.channel.id;
    saveSettings(settings);
    return interaction.editReply('✅ Verify channel set.');
  }

  if (interaction.commandName === 'pauseverify') {
    settings[gid].paused = true;
    saveSettings(settings);
    return interaction.editReply('⏸ Verification paused.');
  }

  if (interaction.commandName === 'resumeverify') {
    settings[gid].paused = false;
    saveSettings(settings);
    return interaction.editReply('▶️ Verification resumed.');
  }

  if (interaction.commandName === 'verify') {
    if (!settings[gid].verifyChannelId) return interaction.editReply('❌ Verify channel not set.');
    if (settings[gid].paused) return interaction.editReply('⏸ Verification paused.');

    const username = interaction.options.getString('username');
    const member = interaction.member;

    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      try { role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 }); }
      catch { return interaction.editReply('❌ I need Manage Roles permission'); }
    }

    try {
      if (interaction.guild.ownerId !== member.id) await member.setNickname(username).catch(() => {});
      await member.roles.add(role);
      return interaction.editReply(`✅ Verified as **${username}**`);
    } catch {
      return interaction.editReply('❌ Move my role above Verified role');
    }
  }

  // --- 24/7 VC join ---
  if (interaction.commandName === 'joinvc') {
    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.editReply('❌ You must be in a voice channel first.');
    
    let connection = getVoiceConnection(interaction.guild.id);
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator
      });
    }
    return interaction.editReply(`✅ Joined **${channel.name}** and will stay 24/7`);
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
