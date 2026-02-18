require('dotenv').config();

const express = require('express');

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.APP_ID;
const PORT = Number(process.env.PORT || 8000);

if (!TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}
if (!APP_ID) {
  console.error('❌ APP_ID missing');
  process.exit(1);
}

const app = express();
app.get('/', (_, res) => res.status(200).send('Bot is alive'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on port ${PORT}`));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const joinVcCommand = new SlashCommandBuilder()
  .setName('joinvc')
  .setDescription('Join your current voice channel and stay connected');

const voiceConnections = new Map(); // guildId -> connection

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  // GLOBAL registration (takes time to show everywhere)
  await rest.put(Routes.applicationCommands(APP_ID), {
    body: [joinVcCommand.toJSON()],
  });

  console.log('✅ Registered GLOBAL slash command: /joinvc');
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('❌ Command registration failed:', e?.message || e);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return;

  if (interaction.commandName !== 'joinvc') return;

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch {
    return;
  }

  const guildId = interaction.guild.id;
  const member = interaction.member;
  const channel = member?.voice?.channel;

  if (!channel) {
    return interaction.editReply('❌ Join a voice channel first, then run `/joinvc`.');
  }

  // kill old connection if exists
  const old = voiceConnections.get(guildId);
  if (old) {
    try { old.destroy(); } catch {}
    voiceConnections.delete(guildId);
  }

  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  voiceConnections.set(guildId, conn);

  // useful logging
  conn.on('stateChange', (oldState, newState) => {
    console.log(`[VOICE ${guildId}] ${oldState.status} -> ${newState.status}`);
  });

  // basic reconnect handling
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      try { conn.destroy(); } catch {}
      voiceConnections.delete(guildId);
    }
  });

  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
    return interaction.editReply(`✅ Joined **${channel.name}**.`);
  } catch (e) {
    try { conn.destroy(); } catch {}
    voiceConnections.delete(guildId);
    console.error('❌ Voice connect failed:', e?.message || e);
    return interaction.editReply(
      '❌ Could not connect to voice.\n' +
      'If you are on Oracle Cloud: make sure your VCN Security List/NSG allows inbound **UDP 50000–65535**.'
    );
  }
});

console.log('🚀 Logging in...');
client.login(TOKEN);