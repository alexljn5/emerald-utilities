const { EmbedBuilder } = require('discord.js');

const messages = [
    "Use .help for an overview of commands!",
    "Remember you can chat with Cream using .talk!",
    "Feeling curious? Try .agony for surreal, unsettling text…",
    "Keep your messages safe and fun!",
    "Easter egg! If you look closely, Big the Cat loves surprises",
    "Tip: Use .cream and .big to get random images anytime."
];

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Hardcoded bot-only channel ID
const BOT_CHANNEL_ID = '1482263791067463711'; // replace with actual numeric channel ID

async function startPopups(client) {
    let channel;
    try {
        channel = await client.channels.fetch(BOT_CHANNEL_ID);
    } catch (err) {
        console.error("[POPUPS] Failed to fetch channel:", err);
        return;
    }

    if (!channel) {
        console.error("[POPUPS] Channel not found:", BOT_CHANNEL_ID);
        return;
    }

    setInterval(async () => {
        const msg = pickRandom(messages);
        const embed = new EmbedBuilder()
            .setTitle("💡 INFBOT Tip")
            .setDescription(msg)
            .setColor("#FFAA00") // warm, visible orange
            .setThumbnail(client.user.displayAvatarURL());

        try {
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error("[POPUPS] Failed to send message:", err);
        }
    }, 5 * 60 * 2000 + Math.floor(Math.random() * 5 * 60 * 4000)); // 10-20 min
}

module.exports = { startPopups };