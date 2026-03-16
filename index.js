// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { DisTube } = require('distube');
const { SpotifyPlugin } = require('@distube/spotify');

// Configure the bot client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Set up Distube with Spotify plugin and 24/7 options
const distube = new DisTube(client, {
  leaveOnEmpty: false,   // stay in VC when empty
  leaveOnFinish: false,  // stay after finishing queue
  leaveOnStop: false,    // stay if stopped
  plugins: [
    new SpotifyPlugin({
      parallel: true,
      emitEventsAfterFetching: true,
      api: {
        clientId: process.env.SPOTIFY_ID,
        clientSecret: process.env.SPOTIFY_SECRET
      }
    })
  ]
});

// Register slash commands (/play and /247vc)
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or playlist (Spotify or YouTube link)')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Song name or link (Spotify playlist/song supported)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('247vc')
    .setDescription('Join your voice channel and stay connected 24/7')
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands((await client.application?.id) || client.user.id),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const member = interaction.member;
  const voiceChannel = member.voice.channel;

  if (commandName === 'play') {
    const query = interaction.options.getString('query');
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.',  ephemeral: true });
    }
    await interaction.deferReply();
    try {
      await distube.play(voiceChannel, query, {
        textChannel: interaction.channel,
        member: member
      });
      await interaction.editReply(`Playing: \`${query}\``);
    } catch (error) {
      console.error(error);
      await interaction.editReply('Error playing the playlist.');
    }
  }

  if (commandName === '247vc') {
    if (!voiceChannel) {
      return interaction.reply({ content: 'Join a voice channel first.',  ephemeral: true });
    }
    try {
      // Simply joining the channel keeps the bot there (Distube handles the connection).
      await distube.voices.join(voiceChannel);
      await interaction.reply('Joined voice channel and will stay connected.');
    } catch (error) {
      console.error(error);
      await interaction.reply('Could not join the voice channel.');
    }
  }
});

// Distube event handling (optional logs)
distube
  .on('playSong', (queue, song) =>
    queue.textChannel?.send({ content: `🎶 Playing ${song.name}` })
  )
  .on('addList', (queue, playlist) =>
    queue.textChannel?.send({ content: `📃 Added playlist: ${playlist.name}` })
  )
  .on('error', (channel, error) => {
    console.error(error);
    channel.send({ content: 'An error occurred while playing music.' });
  });

client.login(process.env.BOT_TOKEN);