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
  MessageFlags,
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

// IMPORTANT:
// - COMMAND_SCOPE=global  (takes time to appear across Discord)
// - COMMAND_SCOPE=guild   (instant, but per-server)
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'guild').toLowerCase();

// Set CLEAN_SLASH_COMMANDS=1 for ONE restart to wipe old commands (fix duplicates), then set back to 0.
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
   WEB SERVER
========================= */
const app = express();
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🌐 Web server listening on port ${PORT}`)
);

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

    // Needed to delete messages in verify channel:
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // Needed for voice state reading (/joinvc):
    GatewayIntentBits.GuildVoiceStates,
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

async function registerGuildCommands(rest, guildId) {
  await rest.put(Routes.applicationGuildCommands(APP_ID, guildId), {
    body: commands,
  });
}

async function wipeAllCommands(rest) {
  console.log('🧹 Wiping ALL existing slash commands (global + guild)...');
  await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
  for (const g of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
  }
  console.log('🧹 Wipe complete.');
}

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (CLEAN_SLASH_COMMANDS) {
    await wipeAllCommands(rest);
  }

  if (COMMAND_SCOPE === 'global') {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log('✅ Registered GLOBAL slash commands');
  } else {
    // To prevent duplicates, clear global when using guild scope:
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

    for (const g of client.guilds.cache.values()) {
      await registerGuildCommands(rest, g.id);
    }
    console.log(`✅ Registered GUILD slash commands for ${client.guilds.cache.size} server(s)`);
  }
}

// Auto-register when added to a new server (guild scope only matters here)
client.on('guildCreate', async (guild) => {
  if (COMMAND_SCOPE !== 'guild') return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await registerGuildCommands(rest, guild.id);
    console.log(`✅ Registered commands in new guild: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error('❌ guildCreate registration failed:', e?.message || e);
  }
});

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
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
    // ignore
  }
});

/* =========================
   SAFE REPLY HELPERS
========================= */
async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    return true;
  } catch {
    return false;
  }
}

async function safeReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(content);
    }
    return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    // ignore
  }
}

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    return safeReply(interaction, '❌ Commands only work in servers.');
  }

  const ok = await safeDefer(interaction);
  if (!ok) return;

  const guildId = interaction.guild.id;

  try {
    if (interaction.commandName === 'pauseverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = true;
      saveSettings(all);
      return safeReply(interaction, '⏸️ Verification is now **paused** in this server.');
    }

    if (interaction.commandName === 'resumeverify') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyPaused = false;
      saveSettings(all);
      return safeReply(interaction, '▶️ Verification is now **resumed** in this server.');
    }

    if (interaction.commandName === 'setverifychannel') {
      const { all, g } = getGuildSettings(guildId);
      g.verifyChannelId = interaction.channel.id;
      g.verifyPaused = false;
      saveSettings(all);
      return safeReply(interaction, '✅ Verify channel set.');
    }

    if (interaction.commandName === 'verify') {
      const { all, g } = getGuildSettings(guildId);

      if (g.verifyPaused) {
        return safeReply(interaction, '⏸️ Verification is currently **paused** in this server.');
      }

      if (!g.verifyChannelId) {
        return safeReply(interaction, '❌ Verify channel not set. Use `/setverifychannel` first.');
      }

      if (interaction.channel.id !== g.verifyChannelId) {
        return safeReply(interaction, '❌ Use `/verify` in the verify channel.');
      }

      const username = interaction.options.getString('username', true);
      const member = interaction.member;

      let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00ff00,
          reason: 'Auto-created by SkygenVerifier',
        });
      }

      // Owner nickname message (always correct)
      let nickMsg = '';
      if (interaction.guild.ownerId === member.id) {
        nickMsg = 'ℹ️ **Owner detected:** Discord does not allow bots to change the server owner’s nickname.';
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
        return safeReply(
          interaction,
          '❌ I can’t add the Verified role. Put my bot role above **Verified** and ensure I have **Manage Roles**.'
        );
      }

      saveSettings(all);
      return safeReply(interaction, `✅ Verified as **${username}**\n${nickMsg}`);
    }

    if (interaction.commandName === 'joinvc') {
      const channel = interaction.member?.voice?.channel;
      if (!channel) return safeReply(interaction, '❌ Join a voice channel first, then run `/joinvc`.');

      // Prevent duplicates / reconnect cleanly
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
        return safeReply(interaction, '❌ Could not connect (try a normal voice channel, not a stage).');
      }

      return safeReply(interaction, `✅ Joined **${channel.name}** and staying 24/7.`);
    }

    return safeReply(interaction, '❌ Unknown command.');
  } catch (e) {
    console.error('interaction error:', e);
    return safeReply(interaction, '❌ Command failed. Check PM2 logs.');
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(TOKEN);