// =========================
// Express web server (health check)
// =========================
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Web server running on port ${PORT}`);
});

// =========================
// Discord bot setup
// =========================
require('dotenv').config();
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

const VERIFIED_ROLE_NAME = 'Verified';

// =========================
// Persistent storage
// =========================
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

function loadSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// =========================
// Client
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

process.on('unhandledRejection', console.error);

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN not set');
  process.exit(1);
}

// =========================
// Ready
// =========================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(o =>
        o.setName('username')
          .setDescription('Minecraft username')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('setverifychannel')
      .setDescription('Set the verification channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName('pauseverify')
      .setDescription('Pause verification system')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName('resumeverify')
      .setDescription('Resume verification system')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  for (const guild of client.guilds.cache.values()) {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );

    // Ensure Verified role exists
    if (!guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME)) {
      await guild.roles.create({
        name: VERIFIED_ROLE_NAME,
        color: 0x00ff00,
        reason: 'Verification role'
      });
    }
  }

  console.log('✅ Commands registered');
});

// =========================
// Message moderation
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const settings = loadSettings();
  const guildSettings = settings[message.guild.id];
  if (!guildSettings) return;

  if (guildSettings.paused) return;
  if (message.channel.id !== guildSettings.verifyChannelId) return;

  try {
    await message.delete();
    await message.author.send(
      "⚠️ **Do not type in the verify channel**\n\nUse:\n`/verify <Minecraft Username>`"
    ).catch(() => {});
  } catch {}
});

// =========================
// Slash commands
// =========================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const settings = loadSettings();
  const guildId = interaction.guild.id;

  settings[guildId] ??= { paused: false };

  // Set verify channel
  if (interaction.commandName === 'setverifychannel') {
    settings[guildId].verifyChannelId = interaction.channel.id;
    settings[guildId].paused = false;
    saveSettings(settings);

    return interaction.reply({
      content: '✅ Verify channel set.',
      ephemeral: true
    });
  }

  // Pause
  if (interaction.commandName === 'pauseverify') {
    settings[guildId].paused = true;
    saveSettings(settings);

    return interaction.reply({
      content: '⏸ Verification paused.',
      ephemeral: true
    });
  }

  // Resume
  if (interaction.commandName === 'resumeverify') {
    settings[guildId].paused = false;
    saveSettings(settings);

    return interaction.reply({
      content: '▶️ Verification resumed.',
      ephemeral: true
    });
  }

  // Verify
  if (interaction.commandName === 'verify') {
    if (settings[guildId].paused) {
      return interaction.reply({
        content: '⏸ Verification is currently paused.',
        ephemeral: true
      });
    }

    const username = interaction.options.getString('username');
    await interaction.deferReply({ ephemeral: true });

    const member = interaction.member;
    const role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);

    if (!member.roles.cache.has(role.id)) {
      if (interaction.guild.ownerId !== member.id) {
        await member.setNickname(username).catch(() => {});
      }
      await member.roles.add(role);
    }

    await interaction.editReply(`✅ Verified as **${username}**`);
  }
});

// =========================
// Login
// =========================
client.login(process.env.DISCORD_BOT_TOKEN);
