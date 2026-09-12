const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { handleCreamMessage } = require('./creamai/cream');
const { callAgonyCreamAI } = require('./creamai/agonycream');
const { logError } = require('./logging/infbot_log_main');
const { getCharacterImage, CHARACTER_CONFIG } = require('./network/sonic_characters');
const game = require('./games/game_main');

const greetedThreads = new Set();

/**
 * Unified character image sender
 */
async function sendCharacterImage(message, type) {
    try {
        const { img, config } = await getCharacterImage(type);

        const serverEmoji = config.emoji
            ? message.guild?.emojis.cache.find(e => e.name.toLowerCase() === config.emoji.toLowerCase())
            : null;

        const emojiStr = serverEmoji
            ? `<:${serverEmoji.name}:${serverEmoji.id}>`
            : '✨';

        const embed = new EmbedBuilder()
            .setTitle(`${emojiStr} ${config.title} ${emojiStr}`)
            .setImage(img)
            .setColor(config.color)
            .setTimestamp();

        await message.channel.send({ embeds: [embed] });

    } catch (err) {
        const channelName = message.channel?.name || 'DM';

        await logError(
            message.client,
            `Image Fetch Failed - ${type}`,
            `Failed for ${message.author.tag} in ${channelName}`,
            [{ name: 'Error', value: err.message }]
        );

        console.error(`[Image:${type}]`, err);
        await message.reply(`Couldn't fetch **${type}** right now.`);
    }
}

/**
 * Auto-generate character commands
 */
const characterCommands = {};

for (const key of Object.keys(CHARACTER_CONFIG)) {
    characterCommands[key] = {
        description: `.${key} - Random ${CHARACTER_CONFIG[key].title} image`,
        execute: (message) => sendCharacterImage(message, key)
    };
}

module.exports = {
    help: {
        description: '.help - Show all available commands',
        execute: async (message) => {
            try {
                const commands = Object.entries(module.exports)
                    .filter(([name]) => name !== 'help')
                    .map(([name, cmd]) => ({
                        name: `.${name}`,
                        value: cmd.description || 'No description',
                        inline: false
                    }));

                const embed = new EmbedBuilder()
                    .setTitle('INFBOT Commands ♡')
                    .setColor('#ff0002')
                    .setThumbnail(message.client.user.displayAvatarURL())
                    .setDescription('Here are all available commands')
                    .addFields(commands)
                    .setFooter({ text: `Requested by ${message.author.tag}` });

                await message.channel.send({ embeds: [embed] });

            } catch (err) {
                await logError(
                    message.client,
                    'Help Command Failed',
                    `Failed for ${message.author.tag}`,
                    [{ name: 'Error', value: err.message }]
                );

                await message.reply("Couldn't show the help list.");
            }
        }
    },

    // Inject all character commands
    ...characterCommands,

    cat: {
        description: 'Random ASCII cat!',
        execute: (message) => {
            const fs = require('fs');
            const path = require('path');
            const dir = path.join(__dirname, 'ascii');

            try {
                const files = fs.readdirSync(dir).filter(f => /^cat\d+\.txt$/.test(f));
                if (!files.length) return message.reply('No cat files found!');

                const randomFile = files[Math.floor(Math.random() * files.length)];
                const cat = fs.readFileSync(path.join(dir, randomFile), 'utf8').trim();

                message.reply(`\`\`\`\n${cat}\n\`\`\``);

            } catch (err) {
                logError(message.client, 'ASCII Cat Failed', 'File read error', [
                    { name: 'Error', value: err.message }
                ]);

                message.reply('Error reading ASCII cats.');
            }
        }
    },

    reverse: {
        description: 'Reverse text',
        execute: (message) => {
            const text = message.content.slice(9).trim();
            if (!text) return message.reply('Nothing to reverse.');

            message.reply(text.split('').reverse().join(''));
        }
    },

    zalgo: {
        description: 'Zalgo text generator',
        execute: (message) => {
            const chars = '\u030d\u030e\u0304\u0305\u033f\u0311\u0306\u0310\u0352\u0357\u0351\u0307\u0308\u0303\u0302\u030a\u0348\u0341\u0344\u034a\u034b\u034c'.split('');
            const text = message.content.slice(6).trim() || 'zalgo';

            const zalgoed = [...text].map(c =>
                c + Array.from({ length: Math.floor(Math.random() * 7) },
                () => chars[Math.floor(Math.random() * chars.length)]).join('')
            ).join('');

            message.reply(zalgoed);
        }
    },

    talk: {
        description: '.talk - Start a chat thread',
        execute: async (message) => {
            let thread;

            try {
                thread = await message.channel.threads.create({
                    name: `Cream Chat - ${message.author.username}`,
                    autoArchiveDuration: 1440
                });

            } catch (err) {
                await logError(message.client, 'Thread Creation Failed', message.author.tag, [
                    { name: 'Error', value: err.message }
                ]);

                return message.reply("Couldn't create thread.");
            }

            try {
                const { img } = await getCharacterImage('cream').catch(() => ({}));

                const embed = new EmbedBuilder()
                    .setTitle(`Hi ${message.author.username}`)
                    .setDescription("Talk to me in this thread!")
                    .setColor('#ff0002');

                if (img) embed.setImage(img);

                await thread.send({ embeds: [embed] });

            } catch {
                await thread.send("Hi! I'm here.");
            }

            const collector = thread.createMessageCollector({ filter: m => !m.author.bot });

            collector.on('collect', async (msg) => {
                try {
                    if (!greetedThreads.has(thread.id)) {
                        greetedThreads.add(thread.id);
                        await thread.send("Hi hi!!");
                    }

                    await handleCreamMessage(msg);

                } catch (err) {
                    await logError(message.client, 'Cream AI Error', thread.id, [
                        { name: 'Error', value: err.message }
                    ]);

                    await thread.send("Something broke.");
                }
            });
        }
    },

    agony: {
        description: '.agony - Generate unsettling text',
        execute: async (message) => {
            const prompt = message.content.slice(7).trim() || 'Describe something eerie.';

            try {
                const response = await callAgonyCreamAI(prompt);
                await message.reply(response || '...');

            } catch (err) {
                await logError(message.client, 'Agony Failed', message.author.tag, [
                    { name: 'Error', value: err.message }
                ]);

                await message.reply("Failed.");
            }
        }
    },

game: {
        description: '.game - simple player actions',
        execute: async (message) => {
            try {
                // Add player to ensure they exist
                await game.addPlayer(message.author.id);
                const player = game.players.get(message.author.id);

                // Build buttons for actions
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('heal')
                            .setLabel('Heal')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('status')
                            .setLabel('Check Status')
                            .setStyle(ButtonStyle.Primary)
                    );

                // Embed showing current player info
                const embed = new EmbedBuilder()
                    .setTitle(`${message.author.username}'s Game`)
                    .setDescription('Click a button to perform an action')
                    .addFields(
                        { name: 'HP', value: `${player.hp}/${player.maxHp}`, inline: true }
                    )
                    .setColor('#ff0002');

                const sentMessage = await message.reply({ embeds: [embed], components: [row] });

                // Create a collector for button clicks
                const collector = sentMessage.createMessageComponentCollector({ time: 60000 });

                collector.on('collect', async interaction => {
                    if (interaction.user.id !== message.author.id) {
                        return interaction.reply({ content: "This isn't your game!", ephemeral: true });
                    }

                    const cmd = interaction.customId; // 'heal' or 'status'
                    const response = game.handleCommand(message.author.id, cmd, []);

                    // Update embed with new info
                    const updatedPlayer = game.players.get(message.author.id);
                    const updatedEmbed = EmbedBuilder.from(embed)
                        .spliceFields(0, 1, { name: 'HP', value: `${updatedPlayer.hp}/${updatedPlayer.maxHp}`, inline: true });

                    await interaction.update({ content: response, embeds: [updatedEmbed], components: [row] });
                });

                collector.on('end', () => {
                    sentMessage.edit({ components: [] }).catch(() => {});
                });

            } catch (err) {
                console.error('[Game] Interactive command failed:', err);
                await message.reply("Something went wrong with the game.");
            }
        }
    }
};