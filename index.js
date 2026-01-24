require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require('discord.js');

/* =========================
   CONFIG & STORAGE
========================= */
const VERIFIED_ROLE_NAME = 'Verified';
const PORT = process.env.PORT || 10000;

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is missing');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

const loadSettings = () => JSON.parse(fs.readFileSync(SETTINGS_FILE));
const saveSettings = s => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

/* =========================
   DISCORD CLIENT
   (Includes Mobile Identity Fix)
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  ws: {
    properties: {
      os: 'linux',
      browser: 'Discord Android',
      device: 'discord.js'
    }
  }
});

process.on('unhandledRejection', console.error);

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  new SlashCommandBuilder().setName('verify').setDescription('Verify Minecraft username').addStringOption(o => o.setName('username').setRequired(true)),
  new SlashCommandBuilder().setName('setverifychannel').setDescription('Set channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName('pauseverify').setDescription('Pause').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName('resumeverify').setDescription('Resume').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

/* =========================
   READY EVENT
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  // Register commands globally (Better for Render)
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }

  // Start Express to satisfy Render's health check
  const app = express();
  app.get('/', (_, res) => res.send('Bot alive and pinging!'));
  app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server on ${PORT}`));

  // SELF-PING SYSTEM (Keep-Alive)
  // Replace the URL below with your actual Render URL
  const RENDER_URL = `https://skygenverifier.onrender.com`; 
  setInterval(() => {
    axios.get(RENDER_URL)
      .then(() => console.log('💓 Heartbeat: Keeping CPU active'))
      .catch(() => console.log('💓 Heartbeat failed (Expected during restart)'));
  }, 300000); // Every 5 minutes
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: true });

  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };

  if (interaction.commandName === 'setverifychannel') {
    settings[gid].verifyChannelId = interaction.channel.id;
    saveSettings(settings);
    return interaction.editReply('✅ Verify channel set');
  }

  if (interaction.commandName === 'pauseverify') {
    settings[gid].paused = true;
    saveSettings(settings);
    return interaction.editReply('⏸ Verification paused');
  }

  if (interaction.commandName === 'resumeverify') {
    settings[gid].paused = false;
    saveSettings(settings);
    return interaction.editReply('▶️ Verification resumed');
  }

  if (interaction.commandName === 'verify') {
    if (settings[gid].paused) return interaction.editReply('⏸ Verification is paused');
    const username = interaction.options.getString('username');
    const member = interaction.member;

    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });
    }

    if (interaction.guild.ownerId !== member.id) {
      await member.setNickname(username).catch(() => {});
    }
    await member.roles.add(role);
    return interaction.editReply(`✅ Verified as **${username}**`);
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
