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

const VERIFIED_ROLE_NAME = 'Verified';
const PORT = Number(process.env.PORT || 8000);

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID;

const COMMAND_SCOPE = (process.env.COMMAND_SCOPE || 'guild').toLowerCase();
const CLEAN_SLASH_COMMANDS = process.env.CLEAN_SLASH_COMMANDS === '1';

if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}
if (!APP_ID) {
  console.error('❌ APP_ID missing in .env');
  process.exit(1);
}

/* Web server */
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

/* Slash commands */
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(o =>
      o.setName('username').setDescription('Minecraft username').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setverifychannel')
    .setDescription('Set the channel where /verify can be used')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('joinvc')
    .setDescription('Join your current voice channel and stay 24/7'),
].map(c => c.toJSON());

/* Voice connections */
const voiceConnections = new Map();

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (CLEAN_SLASH_COMMANDS) {
    console.log('🧹 Wiping old slash commands...');
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: [] });
    }
    console.log('🧹 Wipe complete.');
  }

  if (COMMAND_SCOPE === 'global') {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.log('✅ Registered GLOBAL slash commands');
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: [] });
    for (const g of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, g.id), { body: commands });
    }
    console.log(`✅ Registered GUILD slash commands for ${client.guilds.cache.size} guild(s)`);
  }
}

/* Ready */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerSlashCommands();
});

/* Interactions */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    try {
      return await interaction.reply({
        content: '❌ Commands only work in servers.',
        flags: MessageFlags.Ephemeral,
      });
    } catch { return; }
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch {
    return;
  }

  try {
    if (interaction.commandName === 'joinvc') {
      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        return await interaction.editReply('❌ Join a voice channel first.');
      }

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
        return await interaction.editReply('❌ Could not connect to voice channel.');
      }

      return await interaction.editReply(`✅ Joined **${channel.name}** and staying 24/7.`);
    }

    if (interaction.commandName === 'setverifychannel') {
      const s = loadSettings();
      s[interaction.guild.id] = { verifyChannelId: interaction.channel.id };
      saveSettings(s);
      return await interaction.editReply('✅ Verify channel set.');
    }

    if (interaction.commandName === 'verify') {
      const s = loadSettings();
      const gid = interaction.guild.id;

      if (!s[gid]?.verifyChannelId) {
        return await interaction.editReply('❌ Verify channel not set.');
      }
      if (interaction.channel.id !== s[gid].verifyChannelId) {
        return await interaction.editReply('❌ Use /verify in the verify channel.');
      }

      const username = interaction.options.getString('username', true);
      const member = interaction.member;

      let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
      if (!role) {
        role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });
      }

      let nickMsg = '';
      if (interaction.guild.ownerId === member.id) {
        nickMsg = 'ℹ️ I can’t change the server owner’s nickname.';
      } else {
        try {
          await member.setNickname(username);
          nickMsg = '✅ Nickname updated.';
        } catch {
          nickMsg = '⚠️ Could not change nickname (permissions/role order).';
        }
      }

      try {
        await member.roles.add(role);
      } catch {
        return await interaction.editReply('❌ I can’t add the Verified role. Check role order.');
      }

      return await interaction.editReply(`✅ Verified as **${username}**\n${nickMsg}`);
    }

    return await interaction.editReply('❌ Unknown command.');
  } catch (e) {
    console.error('interaction error:', e);
    try {
      return await interaction.editReply('❌ Command failed. Check PM2 logs.');
    } catch {}
  }
});

client.login(TOKEN);