# SkygenVerifier Discord Bot

A Discord bot designed for Minecraft communities to link users' Discord accounts with their Minecraft Bedrock usernames.

## Features

- **Simple Verification**: Users verify with `/verify <MinecraftUsername>`
- **Automatic Nickname Updates**: Discord nickname is automatically set to Minecraft username
- **Verified Role Assignment**: Automatically assigns a "Verified" role to unlock server channels
- **Works with Minecraft Bedrock Edition**: Designed specifically for Bedrock communities

## Setup Instructions

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name (e.g., "SkygenVerifier")
3. Go to the "Bot" section and click "Add Bot"
4. Under "Privileged Gateway Intents", enable:
   - **Server Members Intent** (required for nickname updates)
5. Click "Reset Token" and copy your bot token (you'll need this for step 3)

### 2. Invite the Bot to Your Server

1. In the Discord Developer Portal, go to "OAuth2" → "URL Generator"
2. Select the following scopes:
   - `bot`
   - `applications.commands`
3. Select the following bot permissions:
   - Manage Roles
   - Manage Nicknames
4. Copy the generated URL and open it in your browser to invite the bot to your server

### 3. Configure the Bot Token

Add your Discord bot token as a secret:
1. In Replit, go to the "Secrets" tab (lock icon in the left sidebar)
2. Add a new secret:
   - Key: `DISCORD_BOT_TOKEN`
   - Value: Your bot token from step 1

### 4. Run the Bot

Click the "Run" button at the top of the Replit interface. The bot will start and register the `/verify` command in your Discord server.

## Usage

### For Server Members

1. Use the `/verify` command in any channel the bot can see
2. Type your Minecraft Bedrock username
3. The bot will:
   - Update your Discord nickname to your Minecraft username
   - Assign you the "Verified" role

### For Server Admins

#### Basic Setup
1. **Role Hierarchy**: Make sure the bot's role is positioned above the "Verified" role in your server's role settings
2. **Channel Permissions**: Set up channel access using @everyone and the Verified role
3. **Bot Permissions**: Ensure the bot has "Manage Roles" and "Manage Nicknames" permissions

#### Setting Up Channel Restrictions
To require verification before accessing your server:

1. **Create a Verification Channel** (e.g., "#verify-here"):
   - Edit Channel → Permissions
   - Allow @everyone to view and send messages
   - This is the only channel new members will see initially

2. **Lock All Other Channels**:
   - For each channel you want to protect, Edit Channel → Permissions
   - Remove or deny @everyone's view permission
   - Add the "Verified" role with view permission
   - Now only verified members can see these channels

3. **That's it!** New members will only see the verification channel until they use `/verify`, then they'll get the Verified role and access to the rest of your server.

## Troubleshooting

- **Server Owner Limitation**: Discord does not allow bots to change the server owner's nickname. If you're the server owner, the bot will assign you the Verified role but you'll need to manually update your nickname to your Minecraft username.
- **"Could not update your nickname"**: The bot's role must be higher than the user's highest role in the role hierarchy
- **"Could not assign the Verified role"**: Ensure the bot has "Manage Roles" permission and its role is above the Verified role
- **Commands not showing**: Wait a few minutes after the bot joins, or try kicking and re-inviting the bot

## Support

If you encounter any issues, check the console logs in Replit for detailed error messages.
