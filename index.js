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
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID;
const PORT = Number(process.env.PORT || 8000);
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'global').toLowerCase(); // global|guild
const CLEAN_SLASH_COMMANDS = process.env.CLEAN_SLASH_COMMANDS === '1';

const VERIFIED_ROLE_NAME = 'Verified';

if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}
if (!APP_ID) {
  console.error('❌ APP_ID missing');
  process.exit(1);
}

/* =========================
   WEB SERVER (health check)
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
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(all) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf8');
}
function getGuildSettings(guildId) {
  const all = loadSettings();
  all[guildId] ??= { verifyPaused: false, verifyChannelId: null };
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
    .setDescription('Join your current voice channel and stay connected'),
].map((c) => c.toJSON());

const voiceConnections = new Map(); // guildId -> connection

async function wipeCommands(rest) {
  console.log('🧹 Cleaning old commands...');
  await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
  for (const g of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
  }
  console.log('🧹 Done.');
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (CLEAN_SLASH_COMMANDS) {
    await wipeCommands(rest);
  }

  if (COMMAND_SCOPE === 'guild') {
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] }); // prevent duplicates
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: commands });
    }
    console.log(`✅ Registered GUILD commands for ${client.guilds.cache.size} server(s)`);
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log('✅ Registered GLOBAL commands (can take time to show everywhere)');
  }
}

client.on('guildCreate', async (guild) => {
  if (COMMAND_SCOPE !== 'guild') return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(APP_ID, guild.id), { body: commands });
    console.log(`✅ Registered commands in new guild: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error('❌ guildCreate registration failed:', e?.message || e);
  }
});

/* =========================
   READY (runs once)
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
  } catch {
    // ignore (missing perms etc.)
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return;

  try {
    // Acknowledge fast to avoid "Unknown interaction"
    await interaction.deferReply({ ephemeral: true });
  } catch {
    return;
  }

  const guildId = interaction.guild.id;

  try {
    if (interaction.commandName === 'pauseverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = true;
      saveSettings(all);
      return interaction.editReply('⏸️ Verification is now **paused** in this server.');
    }

    if (interaction.commandName === 'resumeverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = false;
      saveSettings(all);
      return interaction.editReply('▶️ Verification is now **resumed** in this server.');
    }

    if (interaction.commandName === 'setverifychannel') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyChannelId = interaction.channel.id;
      g.verifyPaused = false;
      saveSettings(all);
      return interaction.editReply('✅ Verify channel set.');
    }

    if (interaction.commandName === 'verify') {
      const { all, g } = getGuildSettings(guildId);

      if (g.verifyPaused) return interaction.editReply('⏸️ Verification is currently **paused**.');
      if (!g.verifyChannelId) return interaction.editReply('❌ Use `/setverifychannel` first.');
      if (interaction.channel.id !== g.verifyChannelId)
        return interaction.editReply('❌ Use `/verify` in the verify channel.');

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

      let nickMsg;
      if (interaction.guild.ownerId === member.id) {
        nickMsg = 'ℹ️ **Owner detected:** I can’t change the server owner’s nickname.';
      } else {
        try {
          await member.setNickname(username);
          nickMsg = '✅ Nickname updated.';
        } catch {
          nickMsg = '⚠️ Could not change nickname (check role order + “Manage Nicknames”).';
        }
      }

      try {
        await member.roles.add(role);
      } catch {
        return interaction.editReply(
          '❌ I can’t add the Verified role. Put my bot role above **Verified** and ensure I have **Manage Roles**.'
        );
      }

      saveSettings(all);
      return interaction.editReply(`✅ Verified as **${username}**\n${nickMsg}`);
    }

    if (interaction.commandName === 'joinvc') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice?.channel;

      if (!channel) return interaction.editReply('❌ Join a voice channel first, then run `/joinvc`.');

      // clean reconnect per guild
      const old = voiceConnections.get(guildId);
      if (old) {
        try { old.destroy(); } catch {}
        voiceConnections.delete(guildId);
      }

      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      voiceConnections.set(guildId, conn);

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        try { conn.destroy(); } catch {}
        voiceConnections.delete(guildId);
        return interaction.editReply('❌ Could not connect (try a normal voice channel, not a stage).');
      }

      return interaction.editReply(`✅ Joined **${channel.name}** and staying connected.`);
    }

    return interaction.editReply('❌ Unknown command.');
  } catch (e) {
    console.error('interaction error:', e);
    try {
      return interaction.editReply('❌ Command failed. Check logs.');
    } catch {}
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(TOKEN);