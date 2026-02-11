require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web server listening on port ${PORT}`);

  // Heartbeat is optional on Oracle (Oracle doesn't sleep)
  if (APP_URL) {
    console.log(`💓 Heartbeat enabled → ${APP_URL}`);
    setInterval(async () => {
      try {
        await axios.get(APP_URL);
        console.log('💓 Heartbeat ping OK');
      } catch {
        console.warn('⚠️ Heartbeat ping failed');
      }
    }, 5 * 60 * 1000);
  }
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
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    // Needed to see & delete messages in a channel:
    GatewayIntentBits.GuildMessages

    // NOTE: MessageContent is NOT required to delete messages.
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
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('Minecraft username')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set THIS channel as the verification channel')
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
    .setDescription('Bot joins your voice channel and stays there 24/7'),
].map(c => c.toJSON());

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    // Global commands can take time to appear on some servers,
    // but you already see them, so this is fine.
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
});

/* =========================
   DELETE MESSAGES IN VERIFY CHANNEL
========================= */
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const settings = loadSettings();
    const g = settings[message.guild.id];
    if (!g?.verifyChannelId) return;
    if (g.paused) return;

    if (message.channel.id !== g.verifyChannelId) return;

    // delete the message
    await message.delete().catch(() => null);

    // DM the user (best-effort)
    await message.author.send(
      'To verify, use the command:\n`/verify <Your Minecraft Username>`'
    ).catch(() => null);

  } catch (e) {
    console.error('❌ verify-channel moderation error:', e);
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ ephemeral: true });

  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };

  // Set verify channel
  if (interaction.commandName === 'setverifychannel') {
    settings[gid].verifyChannelId = interaction.channel.id;
    settings[gid].paused = false;
    saveSettings(settings);

    return interaction.editReply('✅ This channel is now the verification channel.');
  }

  // Pause / resume
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

  // Join VC (stay)
  if (interaction.commandName === 'joinvc') {
    const vc = interaction.member.voice?.channel;
    if (!vc) return interaction.editReply('❌ Join a voice channel first, then run `/joinvc`.');

    let conn = getVoiceConnection(interaction.guild.id);
    if (!conn) {
      conn = joinVoiceChannel({
        channelId: vc.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true
      });
    }

    // Save preferred VC so you can auto-join later if you want
    settings[gid].vcChannelId = vc.id;
    saveSettings(settings);

    return interaction.editReply(`✅ Joined **${vc.name}** and will stay.`);
  }

  // Verify
  if (interaction.commandName === 'verify') {
    if (!settings[gid].verifyChannelId) {
      return interaction.editReply('❌ Verification not set up yet. Run `/setverifychannel` in your verify channel.');
    }
    if (settings[gid].paused) {
      return interaction.editReply('⏸ Verification is currently paused.');
    }

    const username = interaction.options.getString('username');
    const member = interaction.member;

    // Ensure role exists
    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      try {
        role = await interaction.guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00ff00,
          reason: 'Created by verifier bot'
        });
      } catch (e) {
        return interaction.editReply('❌ I need **Manage Roles** permission to create the Verified role.');
      }
    }

    // Nickname
    if (interaction.guild.ownerId !== member.id) {
      try {
        await member.setNickname(username);
      } catch (e) {
        return interaction.editReply('❌ I could not change your nickname. Give me **Manage Nicknames**, and make sure my role is high enough.');
      }
    }

    // Role
    try {
      await member.roles.add(role);
    } catch (e) {
      return interaction.editReply(`❌ I could not give the role. Move my bot role **above** the **${VERIFIED_ROLE_NAME}** role in Server Settings → Roles.`);
    }

    return interaction.editReply(`✅ Verified as **${username}**`);
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
