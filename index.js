// =========================
// Setup & Environment
// =========================
require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const VERIFIED_ROLE_NAME = 'Verified';

// =========================
// Storage
// =========================
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE)); }
  catch { return {}; }
};
const saveSettings = s =>
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

// =========================
// Discord Client Setup
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// Debugging listeners
client.on('debug', d => console.log(`[DEBUG] ${d}`));
client.on('error', e => console.error(`[WS ERROR] ${e}`));
process.on('unhandledRejection', console.error);

// =========================
// Slash Commands Definition
// =========================
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
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

// =========================
// Events
// =========================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    console.log('📦 Registering commands...');
    await rest.put(
      Routes.applicationCommands(client.application.id),
      { body: commands }
    );
    console.log('✅ Commands registered globally');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
});

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
    return interaction.editReply('⏸ Paused');
  }

  if (interaction.commandName === 'resumeverify') {
    settings[gid].paused = false;
    saveSettings(settings);
    return interaction.editReply('▶️ Resumed');
  }

  if (interaction.commandName === 'verify') {
    if (settings[gid].paused) return interaction.editReply('⏸ Verification paused');

    const username = interaction.options.getString('username');
    const member = interaction.member;

    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });
    }

    if (!member.roles.cache.has(role.id)) {
      if (interaction.guild.ownerId !== member.id) {
        await member.setNickname(username).catch(() => {});
      }
      await member.roles.add(role);
    }
    return interaction.editReply(`✅ Verified as **${username}**`);
  }
});

// =========================
// Start Server and Login
// =========================
app.get('/', (_, res) => res.send('Bot is active'));

app.listen(PORT, () => {
  console.log(`🌐 Web server active on port ${PORT}`);
  
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.error('❌ TOKEN MISSING');
  } else {
    console.log("⏳ Starting Discord login...");
    client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);
  }
});
