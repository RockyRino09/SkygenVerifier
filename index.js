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
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const VERIFIED_ROLE_NAME = 'Verified';
const VERIFY_CHANNEL_ID = '1442530968190845089';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: ['CHANNEL'] // Required for DMs and uncached channels
});

// Error handling for unhandled rejections
process.on('unhandledRejection', console.error);

// Make sure the token is set
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
      )
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    console.log('🔄 Registering slash commands...');
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

  // Role setup
  console.log('🔄 Setting up roles...');
  for (const guild of client.guilds.cache.values()) {
    let verifiedRole = guild.roles.cache.find(r => r.name === VERIFIED_ROLE_NAME);
    if (!verifiedRole) {
      try {
        verifiedRole = await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00FF00,
          reason: 'Created by SkygenVerifier bot'
        });
        console.log(`✅ Created "${VERIFIED_ROLE_NAME}" role in ${guild.name}`);
      } catch (error) {
        console.log(`⚠️ Could not create Verified role in ${guild.name}: ${error.message}`);
      }
    }
  }
  console.log('✅ Role setup complete!');
});

// =========================
// Message deletion in verify channel
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // ignore bot messages
  if (message.channel.id !== VERIFY_CHANNEL_ID) return; // only in verify channel

  try {
    await message.delete();
    console.log(`🧹 Deleted message in verify channel from ${message.author.tag}`);

    // Send DM
    await message.author.send(
      "⚠️ **Please do not type in the verify channel.**\n\nTo verify, use:\n`/verify <Your Minecraft Username>`"
    ).catch(() => {
      console.log(`ℹ️ Could not send DM to ${message.author.tag} (possibly closed DMs).`);
    });
  } catch (err) {
    console.error("❌ Error deleting message or sending DM:", err);
  }
});

// =========================
// Slash command handler
// =========================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    const minecraftUsername = interaction.options.getString('username');

    await interaction.deferReply({ flags: 64 }); // ephemeral

    try {
      const member = interaction.member;
      const guild = interaction.guild;

      let verifiedRole = guild.roles.cache.find(role => role.name === VERIFIED_ROLE_NAME);
      if (!verifiedRole) {
        verifiedRole = await guild.roles.create({
          name: VERIFIED_ROLE_NAME,
          color: 0x00FF00,
          reason: 'Created by SkygenVerifier bot'
        });
      }

      if (member.roles.cache.has(verifiedRole.id)) {
        await interaction.editReply({
          content: `ℹ️ You are already verified as **${member.nickname || member.user.username}**!`
        });
        return;
      }

      const isOwner = guild.ownerId === member.id;

      if (!isOwner) {
        try {
          await member.setNickname(minecraftUsername);
        } catch {
          await interaction.editReply({
            content: "❌ I couldn't update your nickname. Make sure I have Manage Nicknames."
          });
          return;
        }
      }

      await member.roles.add(verifiedRole);

      await interaction.editReply({
        content: `✅ Successfully verified! Your nickname has been set to **${minecraftUsername}**.`
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
  console.log(`📥 Bot joined new server: ${guild.name}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(option =>
        option.setName('username')
              .setDescription('Your Minecraft Bedrock username')
              .setRequired(true)
      )
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guild.id),
      { body: commands }
    );
    console.log(`✅ Registered commands for new guild: ${guild.name}`);
  } catch (error) {
    console.error('❌ Error registering commands for new guild:', error);
  }
});

// =========================
// Login
// =========================
client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
  console.error('❌ Failed to login:', error);
  process.exit(1);
});
