const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Web server running on port ${PORT}`);
});
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const VERIFIED_ROLE_NAME = 'Verified';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent // optional, only needed if you read messages
  ]
});

// Error handling for uncaught promise rejections
process.on('unhandledRejection', console.error);

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error('❌ ERROR: DISCORD_BOT_TOKEN is not set!');
  console.error('📝 Please add your Discord bot token as a secret named "DISCORD_BOT_TOKEN"');
  process.exit(1);
}

// Ready event
client.once('ready', async () => {
  console.log(`✅ SkygenVerifier bot is online as ${client.user.tag}`);
  console.log(`📊 Serving ${client.guilds.cache.size} server(s)`);

  // Slash command definition
  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('Your Minecraft Bedrock username')
          .setRequired(true)
      )
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

  // Register slash commands for all guilds
  try {
    console.log('🔄 Registering slash commands...');
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
      console.log(`✅ Registered commands for guild: ${guild.name}`);
    }
    console.log('✅ All slash commands registered successfully!');
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
          reason: 'Created by SkygenVerifier bot for verified members'
        });
        console.log(`✅ Created "${VERIFIED_ROLE_NAME}" role in ${guild.name}`);
      } catch (error) {
        console.log(`⚠️ Could not create Verified role in ${guild.name}: ${error.message}`);
      }
    }
  }
  console.log('✅ Role setup complete!');
});

// Interaction handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'verify') {
    const minecraftUsername = interaction.options.getString('username');

    await interaction.deferReply({ ephemeral: true });

    try {
      const member = interaction.member;
      const guild = interaction.guild;

      let verifiedRole = guild.roles.cache.find(role => role.name === VERIFIED_ROLE_NAME);

      if (!verifiedRole) {
        try {
          verifiedRole = await guild.roles.create({
            name: VERIFIED_ROLE_NAME,
            color: 0x00FF00,
            reason: 'Created by SkygenVerifier bot for verified members'
          });
          console.log(`✅ Created "${VERIFIED_ROLE_NAME}" role in ${guild.name}`);
        } catch (error) {
          console.error('❌ Error creating Verified role:', error);
          await interaction.editReply({
            content: '❌ Could not create the Verified role. Please ensure the bot has "Manage Roles" permission.'
          });
          return;
        }
      }

      if (member.roles.cache.has(verifiedRole.id)) {
        await interaction.editReply({
          content: `ℹ️ You are already verified as **${member.nickname || member.user.username}**!`
        });
        return;
      }

      const isOwner = guild.ownerId === member.id;
      let nicknameUpdated = false;

      if (!isOwner) {
        try {
          await member.setNickname(minecraftUsername);
          nicknameUpdated = true;
          console.log(`✅ Updated nickname for ${member.user.tag} to ${minecraftUsername}`);
        } catch (error) {
          console.error('❌ Error updating nickname:', error);
          await interaction.editReply({
            content: '❌ Could not update your nickname. Please ensure the bot has "Manage Nicknames" permission and is positioned above your role in the role hierarchy.'
          });
          return;
        }
      }

      try {
        await member.roles.add(verifiedRole);
        console.log(`✅ Added Verified role to ${member.user.tag}`);
      } catch (error) {
        console.error('❌ Error adding Verified role:', error);
        await interaction.editReply({
          content: '❌ Could not assign the Verified role. Please ensure the bot has "Manage Roles" permission.'
        });
        return;
      }

      if (isOwner) {
        await interaction.editReply({
          content: `✅ Successfully verified! You've been given the Verified role.\n\n⚠️ **Note:** As the server owner, Discord doesn't allow bots to change your nickname. Please manually set your nickname to **${minecraftUsername}**.`
        });
        console.log(`🎉 ${member.user.tag} verified as ${minecraftUsername} (server owner - nickname not updated)`);
      } else {
        await interaction.editReply({
          content: `✅ Successfully verified! Your nickname has been updated to **${minecraftUsername}** and you've been given the Verified role.`
        });
        console.log(`🎉 ${member.user.tag} verified as ${minecraftUsername}`);
      }

    } catch (error) {
      console.error('❌ Verification error:', error);
      await interaction.editReply({
        content: '❌ An error occurred during verification. Please try again later.'
      });
    }
  }
});

// Handle joining new servers
client.on('guildCreate', async guild => {
  console.log(`📥 Bot joined new server: ${guild.name}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('verify')
      .setDescription('Verify your Minecraft Bedrock username')
      .addStringOption(option =>
        option
          .setName('username')
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

// Login
client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
  console.error('❌ Failed to login:', error);
  process.exit(1);
});
