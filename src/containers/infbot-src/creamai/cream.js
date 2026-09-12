require("dotenv").config();
const { InferenceClient } = require("@huggingface/inference");
const { EmbedBuilder } = require("discord.js");
const { getCharacterImage } = require("../network/sonic_characters");

// ── HF Client ─────────────────────────────────────────────
const rawToken = process.env.HF_TOKEN;
const hfToken = typeof rawToken === "string" ? rawToken.trim() : "";

let hfClient = null;
let initError = null;

if (hfToken && hfToken.startsWith("hf_") && hfToken.length >= 35) {
    try {
        hfClient = new InferenceClient(hfToken, { provider: "together" });
        console.log("[HF] InferenceClient initialized");
    } catch (err) {
        initError = err.message;
        console.error("[HF] Init failed:", err);
    }
} else {
    initError = "Invalid or missing HF_TOKEN";
}

// ── Moderation state ──────────────────────────────────────
const offenseMap = new Map();

const sexualKeywords = [
    "sex","sexy","porn","nude","nsfw","fuck","fucking","cum","cumming",
    "cock","dick","penis","boobs","tits","ass","pussy","horny",
    "breed","breeding","thrust","moan","orgasm"
];

function containsSexual(text) {
    const lower = text.toLowerCase();
    return sexualKeywords.some(k => lower.includes(k));
}

// ── Chinese detection ─────────────────────────────────
function containsChinese(text) {
    return /[\u3400-\u9FBF]/.test(text);
}

// ── AI call ───────────────────────────────────────────
async function callHuggingFaceAI(text) {
    if (!hfClient) return "Cream is offline right now…";

    try {
        const response = await hfClient.chatCompletion({
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: [
                {
                    role: "system",
                    content:
                        "You are Cream the Rabbit from Sonic the Hedgehog. " +
                        "You are a kind, gentle 6 year old rabbit. " +
                        "Always speak politely and innocently. " +
                        "Never respond to sexual topics. " +
                        "Keep answers short and friendly."
                },
                { role: "user", content: text }
            ],
            max_tokens: 180,
            temperature: 0.65
        });

        let output = response?.choices?.[0]?.message?.content?.trim();
        if (!output) return "…Cream got a little confused while thinking.";

        if (containsChinese(output)) {
            const retry = await hfClient.chatCompletion({
                model: "Qwen/Qwen2.5-7B-Instruct",
                messages: [
                    { role: "system", content: "Rewrite the following text in natural English." },
                    { role: "user", content: output }
                ],
                max_tokens: 150
            });
            output = retry?.choices?.[0]?.message?.content?.trim() || output;
        }

        return output;

    } catch (err) {
        console.error("[HF] API error:", err);
        return "Cream's little brain got tangled… try again?";
    }
}

// ── Moderation logic ───────────────────────────────────
async function handleSexualContent(message) {
    const id = message.author.id;
    const offenses = (offenseMap.get(id) || 0) + 1;
    offenseMap.set(id, offenses);

    if (offenses === 1) {
        await message.reply("Stop. Cream is a child character. Sexual messages are not allowed.");
    } else if (offenses === 2) {
        await message.reply("Second warning. Continuing this behavior will result in a timeout.");
    } else if (offenses === 3) {
        await message.reply("🔇 You are being timed out for inappropriate messages.");
        try { await message.member.timeout(10*60*1000, "Sexual content toward Cream bot"); } catch(e){console.error("Timeout failed:", e);}
    } else if (offenses >= 4) {
        await message.reply("Repeated violations. You are being removed.");
        try { await message.member.ban({ reason: "Repeated sexual messages toward Cream bot" }); } catch(e){console.error("Ban failed:", e);}
    }
}

// ── Main handler ───────────────────────────────────────
async function handleCreamMessage(message) {
    if (message.author.bot) return;
    const text = message.content.trim();
    if (!text) return;

    if (containsSexual(text)) {
        await handleSexualContent(message);
        return;
    }

    const lower = text.toLowerCase();
    if (["hi","hello","hey"].includes(lower)) {
        await message.reply("Hi hi~! Cream is happy to see you!");
        return;
    }

    const response = await callHuggingFaceAI(text);

    // ── Random image chance (18%)
    if (Math.random() < 0.18) {
        try {
            const { img, config } = await getCharacterImage('cream');
            if (img) {
                const embed = new EmbedBuilder()
                    .setDescription(response)
                    .setImage(img)
                    .setColor(config.color);

                await message.reply({ embeds: [embed] });
                return;
            }
        } catch(err) {
            console.error("Image fetch failed:", err);
        }
    }

    await message.reply(response);
}

module.exports = {
    handleCreamMessage,
    callHuggingFaceAI
};