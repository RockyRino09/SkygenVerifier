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
  PermissionsBitField
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

/* =========================
   CONFIG
========================= */
const VERIFIED_ROLE_NAME = 'Verified';
const PORT = process.env.PORT || 8000;

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}

/* =========================
   WEB SERVER
========================= */
const app = express();
app.get('/', (_, res) => res.send('Bot alive'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
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
const saveSettings = (data) =>
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));

/* =========================
   CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

/* =========================
   COMMANDS
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

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
    .setDescription('Bot joins your voice channel and stays')
].map(c => c.toJSON());

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });

  console.log('✅ Slash commands registered');
});

/* =========================
   VERIFY CHANNEL DELETE
========================= */
client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;

  const settings = loadSettings();
  const g = settings[message.guild.id];
  if (!g?.verifyChannelId || g.paused) return;
  if (message.channel.id !== g.verifyChannelId) return;

  try {
    await message.delete();
    await message.author.send(
      'To verify, use:\n`/verify <Your Minecraft Username>`'
    ).catch(() => {});
  } catch (e) {
    console.error('Delete failed:', e.message);
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  let replied = false;

  try {
    await interaction.deferReply({ ephemeral: true });
    replied = true;

    const settings = loadSettings();
    const gid = interaction.guild.id;
    settings[gid] ??= { paused: false };

    if (interaction.commandName === 'setverifychannel') {
      settings[gid].verifyChannelId = interaction.channel.id;
      settings[gid].paused = false;
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

    if (interaction.commandName === 'joinvc') {
      const vc = interaction.member.voice?.channel;
      if (!vc) return interaction.editReply('❌ Join a VC first');

      if (!getVoiceConnection(interaction.guild.id)) {
        joinVoiceChannel({
          channelId: vc.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: true
        });
      }

      return interaction.editReply(`✅ Joined **${vc.name}**`);
    }

    if (interaction.commandName === 'verify') {
      if (!settings[gid].verifyChannelId)
        return interaction.editReply('❌ Verify channel not set');

      if (settings[gid].paused)
        return interaction.editReply('⏸ Verification paused');

      const username = interaction.options.getString('username');
      const member = interaction.member;

      let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });
      }

      if (interaction.guild.ownerId !== member.id) {
        await member.setNickname(username);
      }

      await member.roles.add(role);
      return interaction.editReply(`✅ Verified as **${username}**`);
    }
  } catch (e) {
    console.error('Interaction error:', e);
    if (!replied) {
      try {
        await interaction.reply({ content: '❌ Error occurred', ephemeral: true });
      } catch {}
    }
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
