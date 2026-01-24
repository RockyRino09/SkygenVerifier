require('dotenv').config();
const express = require('express');
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
   CONFIG
========================= */

const VERIFIED_ROLE_NAME = 'Verified';
const PORT = process.env.PORT || 10000;

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is missing');
  process.exit(1);
}

/* =========================
   STORAGE
========================= */

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

const loadSettings = () => JSON.parse(fs.readFileSync(SETTINGS_FILE));
const saveSettings = s => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

/* =========================
   DISCORD CLIENT
========================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

process.on('unhandledRejection', console.error);

/* =========================
   SLASH COMMANDS
========================= */

const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
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
    .setDescription('Pause verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('resumeverify')
    .setDescription('Resume verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

/* =========================
   READY
========================= */

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  for (const guild of client.guilds.cache.values()) {
    console.log(`📦 Registering commands in ${guild.name}`);
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
  }

  console.log('✅ Slash commands registered');

  // Start Express ONLY after Discord is ready
  const app = express();
  app.get('/', (_, res) => res.send('Bot alive'));
  app.listen(PORT, () => console.log(`🌐 Web server on ${PORT}`));
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
    if (settings[gid].paused) {
      return interaction.editReply('⏸ Verification is paused');
    }

    const username = interaction.options.getString('username');
    const member = interaction.member;

    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      role = await interaction.guild.roles.create({
        name: VERIFIED_ROLE_NAME,
        color: 0x00ff00
      });
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
