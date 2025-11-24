# SkygenVerifier - Discord Bot for Minecraft Verification

## Project Overview
A Discord bot that verifies Minecraft Bedrock players by linking their Discord account to their Minecraft username. Automatically updates nicknames and assigns a "Verified" role.

## Architecture
- **Technology**: Node.js with discord.js v14
- **Main File**: index.js
- **Command**: `/verify <username>` slash command

## Key Features
1. Slash command registration on bot startup
2. Automatic nickname updates
3. Verified role creation and assignment
4. Ephemeral replies for privacy
5. One-time verification check (prevents re-verification)

## Configuration
- **Required Secret**: `DISCORD_BOT_TOKEN` - Discord bot token from Developer Portal
- **Required Permissions**: Manage Roles, Manage Nicknames
- **Required Intents**: Guilds, Guild Members

## Recent Changes
- 2025-11-24: Removed Unverified role system for simpler @everyone-based channel restrictions
- 2025-11-24: Added server owner detection to handle Discord's limitation on changing owner nicknames
- 2025-11-24: Fixed deprecated API warnings (clientReady event, reply flags, role colors)
- 2025-11-24: Initial bot creation with /verify command, nickname updates, and role assignment

## Dependencies
- discord.js: Discord API wrapper for bot functionality
