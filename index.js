// =========================
// Express web server (health check)
// =========================
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Web server running on port ${PORT}`);
});

// =========================
// Discord bot setup
// =========================
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');

const VERIFIED_ROLE_NAME = 'Verified';

// 🔹 Stores verify channel per server
const verifyChannels = new Map(); // guildId -> channelId

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: ['CHANNEL']
});

process.on('unhandledRejection', console.error);

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ ERROR: DISCORD_BOT_TOKEN is not set!');
  process.exit(1);
}

// =========================
// Ready event
// =========================
client.once('ready', async () => {
  console.log(`✅ SkygenVerifier bot is online as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} server(s)`);

  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(option =>
        option.setName('username')
          .setDescription('Your Minecraft Bedrock username')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('setverifychannel')
      .setDescription('Set this channel as the verification channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
      console.log(`✅ Registered commands for guild: ${guild.name}`);
    }
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }

  // Ensure Verified role exists
  for (const guild of client.guilds.cache.values()) {
    let role = guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!role) {
      try {
        await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00FF00,
          reason: 'Created by SkygenVerifier bot'
        });
        console.log(`✅ Created Verified role in ${guild.name}`);
      } catch (e) {
        console.log(`⚠️ Could not create role in ${guild.name}`);
      }
    }
  }
});

// =========================
// Message deletion in verify channel
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const verifyChannelId = verifyChannels.get(message.guild.id);
  if (!verifyChannelId) return;
  if (message.channel.id !== verifyChannelId) return;

  try {
    await message.delete();

    await message.author.send(
      "⚠️ **Please do not type in the verify channel.**\n\n" +
      "To verify, use:\n`/verify <Your Minecraft Username>`"
    ).catch(() => {});
  } catch (err) {
    console.error("❌ Verify channel moderation error:", err);
  }
});

// =========================
// Slash command handler
// =========================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // 🔧 Set verify channel
  if (commandName === 'setverifychannel') {
    verifyChannels.set(interaction.guild.id, interaction.channel.id);

    await interaction.reply({
      content: '✅ This channel is now set as the verification channel.',
      ephemeral: true
    });
    return;
  }

  // ✅ Verify command
  if (commandName === 'verify') {
    const minecraftUsername = interaction.options.getString('username');
    await interaction.deferReply({ ephemeral: true });

    try {
      const member = interaction.member;
      const guild = interaction.guild;

      let verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
      if (!verifiedRole) {
        verifiedRole = await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00FF00
        });
      }

      if (member.roles.cache.has(verifiedRole.id)) {
        await interaction.editReply({
          content: `ℹ️ You are already verified as **${member.nickname || member.user.username}**`
        });
        return;
      }

      if (guild.ownerId !== member.id) {
        try {
          await member.setNickname(minecraftUsername);
        } catch {
          await interaction.editReply({
            content: "❌ I can't change your nickname. Check my permissions."
          });
          return;
        }
      }

      await member.roles.add(verifiedRole);

      await interaction.editReply({
        content: `✅ Verified successfully! Nickname set to **${minecraftUsername}**`
      });

    } catch (error) {
      console.error("❌ Verification error:", error);
      await interaction.editReply({
        content: "❌ An error occurred during verification."
      });
    }
  }
});

// =========================
// Handle joining new servers
// =========================
client.on('guildCreate', async (guild) => {
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(option =>
        option.setName('username')
          .setDescription('Your Minecraft Bedrock username')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('setverifychannel')
      .setDescription('Set this channel as the verification channel')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
    console.log(`✅ Registered commands for ${guild.name}`);
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
});

// =========================
// Login
// =========================
client.login(process.env.DISCORD_BOT_TOKEN);
