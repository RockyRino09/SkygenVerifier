// index.js
// SkygenVerifier — all-in-one (verify + verify channel + pause/resume + 24/7 voice)
// NOTE: Discord slash command names MUST be lowercase.
// So "24/7VC" cannot be the command name. This uses: /247vc

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
  ChannelType,
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

// COMMAND_SCOPE: "global" (slow to propagate) OR "guild" (instant per server)
const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'guild').toLowerCase();

// Set CLEAN_SLASH_COMMANDS=1 for ONE restart to wipe old commands everywhere,
// then set it back to 0.
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
   WEB SERVER (health check)
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

function saveSettings(all) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function getGuildSettings(guildId) {
  const all = loadSettings();
  if (!all[guildId]) all[guildId] = { verifyPaused: false, verifyChannelId: null };
  return { all, g: all[guildId] };
}

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    // needed to delete typed messages in verify channel
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // needed to read member voice channel for /247vc
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

  // Command requested as "24/7VC" but must be lowercase. Using /247vc.
  new SlashCommandBuilder()
    .setName('247vc')
    .setDescription('Join your current voice channel and try to stay connected 24/7'),
].map((c) => c.toJSON());

/* =========================
   COMMAND REGISTRATION
========================= */
async function wipeAllCommands(rest) {
  console.log('🧹 Wiping ALL slash commands (global + all guilds)...');
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
    // Register global
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });

    // Also clear guild-scoped commands so old guild commands don’t linger
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
    }

    console.log('✅ Registered GLOBAL slash commands');
  } else {
    // Guild scope: clear global to prevent duplicates
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });

    // Register per guild
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: commands });
    }

    console.log(`✅ Registered GUILD slash commands for ${client.guilds.cache.size} guild(s)`);
  }
}

// If added to a new server, push guild commands instantly (guild scope only)
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
   READY
========================= */
let didReady = false;
client.once('ready', async () => {
  if (didReady) return;
  didReady = true;

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
  } catch {
    // ignore (missing perms etc.)
  }

  // Try DM warning
  message.author
    .send(
      '⚠️ **Do not type in the verify channel**\n\nUse:\n`/verify <Your Minecraft Bedrock username>`'
    )
    .catch(() => {});
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
   VOICE: 24/7 CONNECTIONS
========================= */
const voiceConnections = new Map(); // guildId -> { connection, channelId }

function destroyVoice(guildId) {
  const entry = voiceConnections.get(guildId);
  if (!entry) return;
  try {
    entry.connection.destroy();
  } catch {}
  voiceConnections.delete(guildId);
}

function attachVoiceRecoveryHandlers(conn, guildId) {
  // Helpful logging (optional)
  conn.on('stateChange', (oldState, newState) => {
    console.log(`🔊 [${guildId}] ${oldState.status} -> ${newState.status}`);
  });

  // Basic recovery approach recommended for disconnects:
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // If Discord is just moving regions / brief UDP blip, it may transition back itself.
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // If it makes it to Signalling/Connecting, it might reach Ready again without a full rebuild.
    } catch {
      // Hard fail: destroy so user can run /247vc again cleanly
      console.log(`🔊 [${guildId}] Disconnected recovery failed -> destroying connection`);
      destroyVoice(guildId);
    }
  });

  conn.on(VoiceConnectionStatus.Destroyed, () => {
    // Ensure map is clean if destroyed elsewhere
    const entry = voiceConnections.get(guildId);
    if (entry?.connection === conn) voiceConnections.delete(guildId);
  });

  conn.on('error', (e) => {
    console.error(`🔊 [${guildId}] Voice error:`, e?.message || e);
  });
}

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return safeReply(interaction, '❌ Commands only work in servers.');

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
      const member = await interaction.guild.members.fetch(interaction.user.id);

      // Find/create Verified role
      let role = interaction.guild.roles.cache.find((r) => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        try {
          role = await interaction.guild.roles.create({
            name: VERIFIED_ROLE_NAME,
            color: 0x00ff00,
            reason: 'Auto-created by SkygenVerifier',
          });
        } catch {
          return safeReply(
            interaction,
            '❌ I could not create the Verified role. Create it manually and give me **Manage Roles**.'
          );
        }
      }

      // Nickname: bots cannot change the server owner’s nickname
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

      // Add role
      try {
        await member.roles.add(role);
      } catch {
        return safeReply(
          interaction,
          "❌ I can’t add the Verified role. Put my bot role above **Verified** and ensure I have **Manage Roles**."
        );
      }

      saveSettings(all);
      return safeReply(interaction, `✅ Verified as **${username}**\n${nickMsg}`);
    }

    if (interaction.commandName === '247vc') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice?.channel;

      if (!channel) {
        return safeReply(interaction, '❌ Join a voice channel first, then run `/247vc`.');
      }

      // Block Stage channels (they can behave differently)
      if (channel.type === ChannelType.GuildStageVoice) {
        return safeReply(interaction, '❌ Stage channels aren’t supported. Use a normal voice channel.');
      }

      // Clean previous connection for this guild
      destroyVoice(guildId);

      // Join
      const conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: true,
      });

      voiceConnections.set(guildId, { connection: conn, channelId: channel.id });
      attachVoiceRecoveryHandlers(conn, guildId);

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        destroyVoice(guildId);
        return safeReply(
          interaction,
          '❌ Could not connect to voice.\nIf you are on a VPS, this is usually UDP being blocked (Discord voice uses high UDP ports).'
        );
      }

      return safeReply(interaction, `✅ Joined **${channel.name}** and will try to stay connected 24/7.`);
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