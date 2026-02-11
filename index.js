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
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on port ${PORT}`));

/* =========================
   STORAGE
========================= */
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

/* =========================
   DISCORD CLIENT
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

process.on('unhandledRejection', console.error);

/* =========================
   SLASH COMMANDS
========================= */
const COMMAND_BUILDERS = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(opt =>
      opt.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set verification channel (run inside the channel)')
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
    .setDescription('Join your current voice channel and stay there'),

  new SlashCommandBuilder()
    .setName('leavevc')
    .setDescription('Leave the voice channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  // Admin command to wipe duplicates then re-register (fixes double /joinvc)
  new SlashCommandBuilder()
    .setName('synccommands')
    .setDescription('Admin: re-sync slash commands (fix duplicates)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
];

const COMMANDS_JSON = COMMAND_BUILDERS.map(c => c.toJSON());

async function registerGlobalCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS_JSON });
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await registerGlobalCommands();
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
});

/* =========================
   VERIFY CHANNEL MODERATION
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

    await message.delete().catch(() => {});
    await message.author.send(
      '⚠️ Do not type in the verify channel.\nUse `/verify <username>` instead.'
    ).catch(() => {});
  } catch (e) {
    console.error('messageCreate error:', e);
  }
});

/* =========================
   SAFE REPLY HELPERS
========================= */
async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content });
    }
    return await interaction.reply({ content, ephemeral });
  } catch (e) {
    // If even that fails, do nothing (prevents crash loops)
    console.error('safeReply error:', e?.message || e);
  }
}

async function safeDefer(interaction) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch (e) {
    console.error('safeDefer error:', e?.message || e);
  }
}

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      return await safeReply(interaction, '❌ Use this command inside a server.');
    }

    const settings = loadSettings();
    const gid = interaction.guildId;
    settings[gid] ??= { paused: false };

    const cmd = interaction.commandName;

    // ---- synccommands ----
    if (cmd === 'synccommands') {
      await safeDefer(interaction);

      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

      // wipe global
      await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
      // wipe this guild too (kills old per-guild commands if you ever used them)
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: [] });
      // re-register
      await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS_JSON });

      return await safeReply(interaction, '✅ Commands re-synced. Close Discord fully and reopen, then type `/` again.');
    }

    // ---- setverifychannel ----
    if (cmd === 'setverifychannel') {
      settings[gid].verifyChannelId = interaction.channelId;
      settings[gid].paused = false;
      saveSettings(settings);
      return await safeReply(interaction, '✅ Verify channel set.');
    }

    // ---- pauseverify ----
    if (cmd === 'pauseverify') {
      settings[gid].paused = true;
      saveSettings(settings);
      return await safeReply(interaction, '⏸ Verification paused.');
    }

    // ---- resumeverify ----
    if (cmd === 'resumeverify') {
      settings[gid].paused = false;
      saveSettings(settings);
      return await safeReply(interaction, '▶️ Verification resumed.');
    }

    // ---- verify ----
    if (cmd === 'verify') {
      await safeDefer(interaction);

      if (!settings[gid].verifyChannelId) {
        return await safeReply(interaction, '❌ Not set up yet. Run `/setverifychannel` in your verify channel.');
      }
      if (settings[gid].paused) {
        return await safeReply(interaction, '⏸ Verification is paused.');
      }

      const username = interaction.options.getString('username', true);

      const member = interaction.member; // should exist because inGuild()
      const guild = interaction.guild;

      // ensure role exists
      let role = guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 }).catch(() => null);
        if (!role) return await safeReply(interaction, '❌ I need **Manage Roles** to create the Verified role.');
      }

      // add role
      await member.roles.add(role).catch(() => {});

      // owner nickname: don’t lie
      if (guild.ownerId === member.id) {
        return await safeReply(
          interaction,
          `✅ Verified as **${username}** (role added).\nℹ️ I can’t change the **server owner’s** nickname — change it manually.`
        );
      }

      // nickname change
      const nickOk = await member.setNickname(username).then(() => true).catch(() => false);

      if (!nickOk) {
        return await safeReply(
          interaction,
          `✅ Verified as **${username}** (role added).\n⚠️ I couldn’t change your nickname. Ensure I have **Manage Nicknames** and my role is above yours.`
        );
      }

      return await safeReply(interaction, `✅ Verified as **${username}** (nickname updated).`);
    }

    // ---- joinvc ----
    if (cmd === 'joinvc') {
      await safeDefer(interaction);

      // member voice state can be null-ish; guard hard
      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return await safeReply(interaction, '❌ Join a voice channel first.');
      }

      const existing = getVoiceConnection(gid);
      if (!existing) {
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: gid,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: true
        });
      }

      return await safeReply(interaction, `🔊 Joined **${voiceChannel.name}** and will stay there.`);
    }

    // ---- leavevc ----
    if (cmd === 'leavevc') {
      await safeDefer(interaction);
      const conn = getVoiceConnection(gid);
      if (!conn) return await safeReply(interaction, 'ℹ️ I am not in a voice channel.');
      conn.destroy();
      return await safeReply(interaction, '👋 Left the voice channel.');
    }

  } catch (e) {
    console.error('interactionCreate crash:', e);
    // IMPORTANT: never crash the process
    try {
      if (interaction && interaction.isChatInputCommand && interaction.isChatInputCommand()) {
        await safeReply(interaction, '❌ Something went wrong.');
      }
    } catch {}
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
