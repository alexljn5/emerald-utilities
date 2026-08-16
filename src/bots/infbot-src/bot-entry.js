require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const commands = require('./commands'); // load your commands
const { startPopups } = require('./randompopups');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

if (!process.env.TOKEN) {
    console.error('No token found!');
    process.exit(1);
}

client.login(process.env.TOKEN).catch(err => {
    console.error('Login failed:', err.message);
    process.exit(1);
});

client.once('clientReady', () => {
    console.log(`Bot is live and hot-reload works! ${new Date().toLocaleTimeString()}`);
});

client.on('messageCreate', (message) => {
    if (message.author.bot) return;

    // Simple prefix for commands
    const prefix = '.';
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();

    const command = commands[commandName];
    if (command) command.execute(message);
});

// start popups in a specific channel
client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
    startPopups(client, 'YOUR_CHANNEL_ID'); // replace with your actual channel ID
});