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

const VERIFIED_ROLE_NAME = 'Verified';
const PORT = Number(process.env.PORT || 8000);

// IMPORTANT: set in .env
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID; // required for clean command registration

// Command registration mode:
// - "guild" = instant updates, best for bots you manage yourself
// - "global" = takes time to appear/update (can look like commands “disappear”)
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'guild').toLowerCase(); // "guild" or "global"

// Set to "1" one time to wipe ALL old commands (global + guild) to remove duplicates:
const CLEAN_SLASH_COMMANDS = process.env.CLEAN_SLASH_COMMANDS === '1';

if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}
if (!APP_ID) {
  console.error('❌ APP_ID missing in .env (needed to register/clean slash commands)');
  process.exit(1);
}

/* Web server (keeps Oracle instance “alive” + optional health check) */
const app = express();
app.get('/', (_, res) => res.send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on ${PORT}`));

/* Storage */
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

/* Discord client */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // needed for nicknames / roles reliably
    GatewayIntentBits.GuildVoiceStates,  // needed for /joinvc
  ],
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

/* Slash commands */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption((o) =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set the channel where /verify can be used')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('joinvc')
    .setDescription('Join your current voice channel and stay 24/7'),
].map((c) => c.toJSON());

/* Voice connections stored per guild */
const voiceConnections = new Map(); // guildId -> connection

async function safeReply(interaction, payload) {
  // Never double-ack an interaction
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {
    // If Discord says "Unknown interaction", it usually timed out; just log it.
    console.error('safeReply error:', e?.message || e);
  }
}

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  // Optional: wipe everything first to kill duplicates
  if (CLEAN_SLASH_COMMANDS) {
    console.log('🧹 CLEAN_SLASH_COMMANDS=1 -> wiping old slash commands (global + guild)...');

    // Clear global
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

    // Clear each guild
    const guildIds = client.guilds.cache.map((g) => g.id);
    for (const gid of guildIds) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, gid), { body: [] });
    }
    console.log('🧹 Wipe complete.');
  }

  if (COMMAND_SCOPE === 'global') {
    // Register global (slow to propagate)
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log('✅ Registered GLOBAL slash commands');
  } else {
    // Register per-guild (instant) + clear global to prevent duplicates
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

    const guildIds = client.guilds.cache.map((g) => g.id);
    for (const gid of guildIds) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, gid), { body: commands });
    }
    console.log(`✅ Registered GUILD slash commands for ${guildIds.length} guild(s) (instant)`);
  }
}

/* Ready */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await registerSlashCommands();
  } catch (e) {
    console.error('❌ Slash command registration failed:', e?.message || e);
  }
});

/* Interactions */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return safeReply(interaction, { content: '❌ Commands only work in servers.', ephemeral: true });
  }

  // Always defer quickly to avoid "Unknown interaction" (3s timeout)
  await interaction.deferReply({ ephemeral: true });

  try {
    // /joinvc
    if (interaction.commandName === 'joinvc') {
      const member = interaction.member; // GuildMember
      const channel = member?.voice?.channel;

      if (!channel) {
        return safeReply(interaction, {
          content: '❌ Join a voice channel first, then run /joinvc again.',
          ephemeral: true,
        });
      }

      // If already connected, destroy and reconnect cleanly
      const existing = voiceConnections.get(channel.guild.id);
      if (existing) {
        try { existing.destroy(); } catch {}
        voiceConnections.delete(channel.guild.id);
      }

      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });

      voiceConnections.set(channel.guild.id, conn);

      conn.on('stateChange', (oldState, newState) => {
        // Useful for debugging reconnections
        console.log(
          `🔊 VC state [${channel.guild.name}]: ${oldState.status} -> ${newState.status}`
        );
      });

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      } catch (e) {
        console.error('❌ VC connect failed:', e?.message || e);
        try { conn.destroy(); } catch {}
        voiceConnections.delete(channel.guild.id);

        return safeReply(interaction, {
          content:
            '❌ I couldn’t connect to that voice channel. Check bot permissions (Connect/Speak) and try again.',
          ephemeral: true,
        });
      }

      return safeReply(interaction, {
        content: `✅ Joined **${channel.name}** and staying 24/7.`,
        ephemeral: true,
      });
    }

    // /setverifychannel
    if (interaction.commandName === 'setverifychannel') {
      const s = loadSettings();
      s[interaction.guild.id] = { verifyChannelId: interaction.channel.id };
      saveSettings(s);

      return safeReply(interaction, { content: '✅ Verify channel set.', ephemeral: true });
    }

    // /verify
    if (interaction.commandName === 'verify') {
      const s = loadSettings();
      const gid = interaction.guild.id;

      if (!s[gid]?.verifyChannelId) {
        return safeReply(interaction, {
          content: '❌ Verify channel not set. Use /setverifychannel in the channel you want.',
          ephemeral: true,
        });
      }
      if (interaction.channel.id !== s[gid].verifyChannelId) {
        return safeReply(interaction, {
          content: '❌ Use /verify in the verify channel only.',
          ephemeral: true,
        });
      }

      const username = interaction.options.getString('username', true);
      const member = interaction.member; // GuildMember

      // Get/create role
      let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00ff00,
          reason: 'Auto-created by SkygenVerifier',
        });
      }

      // Nickname: Discord does not allow changing the server OWNER’s nickname via bots.
      let nickResult = '';
      if (interaction.guild.ownerId === member.id) {
        nickResult = 'ℹ️ Note: I can’t change the server owner’s nickname (Discord limitation).';
      } else {
        try {
          await member.setNickname(username);
          nickResult = '✅ Nickname updated.';
        } catch {
          nickResult = '⚠️ I couldn’t change your nickname (missing “Manage Nicknames” permission).';
        }
      }

      // Role add
      try {
        await member.roles.add(role);
      } catch {
        return safeReply(interaction, {
          content:
            '❌ I couldn’t add the Verified role. Make sure my role is ABOVE the Verified role and I have “Manage Roles”.',
          ephemeral: true,
        });
      }

      return safeReply(interaction, {
        content: `✅ Verified as **${username}**\n${nickResult}`,
        ephemeral: true,
      });
    }

    // Unknown command (shouldn’t happen)
    return safeReply(interaction, { content: '❌ Unknown command.', ephemeral: true });
  } catch (err) {
    console.error('interaction handler error:', err);
    return safeReply(interaction, {
      content: '❌ Something went wrong handling that command. Check PM2 logs.',
      ephemeral: true,
    });
  }
});

client.login(TOKEN);