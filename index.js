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

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');

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
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

/* =========================
   DISCORD CLIENT (IMPORTANT INTENTS)
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    // Needed for deleting verify-channel messages
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // Needed for voice channel info
    GatewayIntentBits.GuildVoiceStates
  ]
});

process.on('unhandledRejection', console.error);

/* =========================
   SLASH COMMANDS
========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username (sets nickname + gives Verified role)')
    .addStringOption(opt =>
      opt.setName('username')
        .setDescription('Your Minecraft username (Bedrock/Java gamertag)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set THIS channel as the verification channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('pauseverify')
    .setDescription('Pause verification system (stops auto-delete in verify channel)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('resumeverify')
    .setDescription('Resume verification system')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('joinvc')
    .setDescription('Join YOUR current voice channel and stay connected (remembers channel)')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('leavevc')
    .setDescription('Leave voice channel and stop staying connected')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

/* =========================
   HELPERS
========================= */
async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content });
    }
    return await interaction.reply({ content, ephemeral });
  } catch (e) {
    // If the interaction expired, do nothing (prevents 10062 spam)
    console.error('⚠️ safeReply failed:', e?.code || e?.message || e);
  }
}

async function ensureVerifiedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({
      name: VERIFIED_ROLE_NAME,
      color: 0x00ff00,
      reason: 'Verification role'
    });
  }
  return role;
}

async function connectToVoice(guild, voiceChannelId) {
  const channel = guild.channels.cache.get(voiceChannelId);
  if (!channel || !channel.isVoiceBased()) return false;

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    return true;
  } catch {
    try { connection.destroy(); } catch {}
    return false;
  }
}

/* =========================
   READY
========================= */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register GLOBAL commands (works for multiple servers)
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global slash commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }

  // Rejoin saved voice channels after restart
  const settings = loadSettings();
  for (const [guildId, s] of Object.entries(settings)) {
    if (!s?.voiceChannelId) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    const ok = await connectToVoice(guild, s.voiceChannelId);
    console.log(ok
      ? `🔊 Rejoined VC in guild ${guild.name}`
      : `⚠️ Could not rejoin VC in guild ${guild.name}`
    );
  }
});

/* =========================
   AUTO DELETE MESSAGES IN VERIFY CHANNEL
========================= */
client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const settings = loadSettings();
  const s = settings[message.guild.id];
  if (!s?.verifyChannelId) return;
  if (s.paused) return;
  if (message.channel.id !== s.verifyChannelId) return;

  try {
    await message.delete();

    await message.author.send(
      'To verify, use:\n`/verify <Your Minecraft Username>`'
    ).catch(() => {});
  } catch (e) {
    console.error('❌ Failed to delete/DM in verify channel:', e?.message || e);
  }
});

/* =========================
   INTERACTIONS
========================= */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return safeReply(interaction, '❌ Use commands in a server, not DMs.');

  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };

  const cmd = interaction.commandName;

  // --- set verify channel
  if (cmd === 'setverifychannel') {
    settings[gid].verifyChannelId = interaction.channel.id;
    settings[gid].paused = false;
    saveSettings(settings);
    return safeReply(interaction, '✅ This channel is now the verify channel.');
  }

  // --- pause/resume
  if (cmd === 'pauseverify') {
    settings[gid].paused = true;
    saveSettings(settings);
    return safeReply(interaction, '⏸ Verification paused.');
  }
  if (cmd === 'resumeverify') {
    settings[gid].paused = false;
    saveSettings(settings);
    return safeReply(interaction, '▶️ Verification resumed.');
  }

  // --- joinvc
  if (cmd === 'joinvc') {
    const member = interaction.member;
    const voice = member?.voice?.channel;

    if (!voice) return safeReply(interaction, '❌ Join a voice channel first, then run `/joinvc`.');

    // Remember it
    settings[gid].voiceChannelId = voice.id;
    saveSettings(settings);

    const ok = await connectToVoice(interaction.guild, voice.id);
    return safeReply(interaction, ok
      ? `✅ Joined **${voice.name}** and will try to stay connected.`
      : `❌ I couldn't join that voice channel. Check my permissions.`
    );
  }

  // --- leavevc
  if (cmd === 'leavevc') {
    const conn = getVoiceConnection(gid);
    if (conn) {
      try { conn.destroy(); } catch {}
    }
    delete settings[gid].voiceChannelId;
    saveSettings(settings);
    return safeReply(interaction, '✅ Left voice and stopped staying connected.');
  }

  // --- verify
  if (cmd === 'verify') {
    if (!settings[gid].verifyChannelId) {
      return safeReply(interaction, '❌ Run `/setverifychannel` in your verify channel first.');
    }
    if (settings[gid].paused) {
      return safeReply(interaction, '⏸ Verification is currently paused.');
    }

    const username = interaction.options.getString('username', true);
    const member = interaction.member;

    // Role
    let role;
    try {
      role = await ensureVerifiedRole(interaction.guild);
    } catch {
      return safeReply(interaction, '❌ I need **Manage Roles** to create/find the Verified role.');
    }

    // Nickname: bots cannot change SERVER OWNER nickname
    let nicknameResult = '';
    if (interaction.guild.ownerId === member.id) {
      nicknameResult = `\n⚠️ I **can’t change the server owner’s nickname** (Discord limitation).`;
    } else {
      try {
        await member.setNickname(username);
        nicknameResult = `\n✅ Nickname set to **${username}**.`;
      } catch {
        nicknameResult = `\n⚠️ I couldn’t change your nickname. Make sure I have **Manage Nicknames** and my role is above yours.`;
      }
    }

    // Add role
    try {
      await member.roles.add(role);
    } catch {
      return safeReply(interaction, `❌ I couldn’t give the role. Move my bot role above **${VERIFIED_ROLE_NAME}**.`);
    }

    return safeReply(interaction, `✅ Verified as **${username}**.${nicknameResult}`);
  }
});

/* =========================
   LOGIN
========================= */
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
