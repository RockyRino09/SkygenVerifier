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

// =========================
// HARD ENV CHECK
// =========================
if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN missing');
  process.exit(1);
}

// =========================
// EXPRESS (Render health)
// =========================
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (_, res) => res.send('Bot alive'));
app.listen(PORT, () => {
  console.log(`🌐 Web server on ${PORT}`);
});

// =========================
// DISCORD CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

process.on('unhandledRejection', console.error);
client.on('error', console.error);

// =========================
// COMMANDS (GLOBAL)
// =========================
const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Verify your Minecraft username')
    .addStringOption(o =>
      o.setName('username')
        .setDescription('Minecraft username')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('pauseverify')
    .setDescription('Pause verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName('resumeverify')
    .setDescription('Resume verification')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(c => c.toJSON());

// =========================
// READY
// =========================
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' })
    .setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    console.log('📦 Registering global commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Commands registered');
  } catch (err) {
    console.error('❌ Command registration failed:', err);
  }
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ ephemeral: true });

  if (interaction.commandName === 'verify') {
    const username = interaction.options.getString('username');
    const VERIFIED_ROLE = 'Verified';

    let role = interaction.guild.roles.cache.find(r => r.name === VERIFIED_ROLE);

    if (!role) {
      try {
        role = await interaction.guild.roles.create({
          name: VERIFIED_ROLE,
          color: 0x00ff00
        });
      } catch {
        return interaction.editReply('❌ Missing Manage Roles permission.');
      }
    }

    try {
      if (interaction.guild.ownerId !== interaction.user.id) {
        await interaction.member.setNickname(username).catch(() => {});
      }
      await interaction.member.roles.add(role);
      return interaction.editReply(`✅ Verified as **${username}**`);
    } catch {
      return interaction.editReply(
        '❌ Move the bot role ABOVE the Verified role.'
      );
    }
  }

  if (interaction.commandName === 'pauseverify') {
    return interaction.editReply('⏸ Verification paused');
  }

  if (interaction.commandName === 'resumeverify') {
    return interaction.editReply('▶️ Verification resumed');
  }
});

// =========================
// LOGIN (IMMEDIATE)
// =========================
console.log('🚀 Logging in...');
client.login(process.env.DISCORD_BOT_TOKEN);
