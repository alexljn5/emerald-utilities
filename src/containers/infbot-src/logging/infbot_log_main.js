const { EmbedBuilder } = require('discord.js');

const LOG_CHANNEL_ID = '1483141799546458192';

async function logError(client, title, description, fields = []) {
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        const embed = new EmbedBuilder()
            .setTitle(`Nuh uh ${title}`)
            .setDescription(description)
            .setColor('#FF0000')
            .setTimestamp()
            .addFields(
                { name: 'Timestamp', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                ...fields
            );

        await channel.send({ embeds: [embed] });
    } catch (logErr) {
        console.error('Logging failed:', logErr);
    }
}

module.exports = { logError };
