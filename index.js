require('dotenv').config();
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const VERIFIED_ROLE_NAME = 'Verified';

// --- Storage ---
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');

const loadSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE)); }
  catch { return {}; }
};
const saveSettings = s => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));

// --- Client Setup with Mobile/JSON Connection Fix ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ],
  // This specific block helps bypass "Silent Hangs" on Render
  ws: {
    properties: {
      browser: 'Discord iOS' 
    }
  }
});

// Detailed Error Logging
client.on('debug', d => console.log(`[DEBUG] ${d}`));
client.on('error', e => console.error(`[WS ERROR] ${e}`));
process.on('unhandledRejection', console.error);

const commands = [
  new SlashCommandBuilder().setName('verify').setDescription('Verify Minecraft username').addStringOption(o => o.setName('username').setRequired(true).setDescription('Username')),
  new SlashCommandBuilder().setName('setverifychannel').setDescription('Set channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName('pauseverify').setDescription('Pause').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName('resumeverify').setDescription('Resume').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

// --- Events ---
client.once('ready', async () => {
  console.log(`✅ SUCCESS: Logged in as ${client.user.tag}`);
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    console.log('📦 Registering commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Commands ready');
  } catch (err) {
    console.error('❌ Command Error:', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: true });
  const settings = loadSettings();
  const gid = interaction.guild.id;
  settings[gid] ??= { paused: false };

  if (interaction.commandName === 'setverifychannel') {
    settings[gid].verifyChannelId = interaction.channel.id;
    saveSettings(settings);
    return interaction.editReply('✅ Channel set');
  }
  if (interaction.commandName === 'pauseverify') {
    settings[gid].paused = true;
    saveSettings(settings);
    return interaction.editReply('⏸ Paused');
  }
  if (interaction.commandName === 'resumeverify') {
    settings[gid].paused = false;
    saveSettings(settings);
    return interaction.editReply('▶️ Resumed');
  }
  if (interaction.commandName === 'verify') {
    if (settings[gid].paused) return interaction.editReply('⏸ Paused');
    const username = interaction.options.getString('username');
    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) role = await interaction.guild.roles.create({ name: VERIFIED_ROLE_NAME, color: 0x00ff00 });
    
    try {
        if (interaction.guild.ownerId !== interaction.member.id) await interaction.member.setNickname(username);
        await interaction.member.roles.add(role);
        return interaction.editReply(`✅ Verified as **${username}**`);
    } catch (e) {
        return interaction.editReply(`❌ Error: Ensure the bot role is HIGHER than the '${VERIFIED_ROLE_NAME}' role.`);
    }
  }
});

// --- Start ---
app.get('/', (req, res) => res.send('Bot is online!'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check live on port ${PORT}`);
  if (process.env.DISCORD_BOT_TOKEN) {
    console.log("🚀 Attempting Login...");
    client.login(process.env.DISCORD_BOT_TOKEN).catch(e => console.error("FATAL LOGIN ERROR:", e));
  } else {
    console.error("❌ NO TOKEN IN ENVIRONMENT VARIABLES");
  }
});
