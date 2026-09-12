require("dotenv").config();
const { InferenceClient } = require("@huggingface/inference");

// ── HF Client Setup ─────────────────────────────────────
const rawToken = process.env.HF_TOKEN;
const hfToken = typeof rawToken === "string" ? rawToken.trim() : "";

let hfClient = null;
let initError = null;

if (hfToken && hfToken.startsWith("hf_") && hfToken.length >= 35) {
    try {
        hfClient = new InferenceClient(hfToken, { provider: "together" });
        console.log("[HF][INFBOT_Agony] Initialized");
    } catch (err) {
        initError = err.message;
        console.error("[HF][INFBOT_Agony] Init failed:", err);
    }
} else {
    initError = "Invalid or missing HF_TOKEN";
}

// ── Chinese detection / English-only ───────────────────
function containsChinese(text) {
    return /[\u3400-\u9FBF]/.test(text);
}

// ── Agony AI call ──────────────────────────────────────
async function callAgonyCreamAI(prompt) {
    if (!hfClient) {
        return `Cream_In_Agony AI is offline: ${initError || "No valid HF_TOKEN found"}`;
    }

    try {
        const response = await hfClient.chatCompletion({
            model: "Qwen/Qwen2.5-7B-Instruct",
            messages: [
                {
                    role: "system",
                    content:
                        "You are Cream in agony, a surreal and industrially disturbing version of Cream the Rabbit. " +
                        "Your responses evoke dark, mechanical dread, decaying factories, and oppressive machinery. " +
                        "Focus on hopelessness, existential unease, and industrial despair. " +
                        "Describe twisted industrial landscapes, grinding gears, smoke-choked rooms, and eerie mechanical sounds. " +
                        "Never include sexual content or real-life gore. Always write in English, concise, and vividly atmospheric."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 250,
            temperature: 0.9
        });

        let output = response?.choices?.[0]?.message?.content?.trim();

        if (!output) return "Cream_In_Agony whispers… the darkness is too heavy.";

        // Auto-rewrite if Chinese detected
        if (containsChinese(output)) {
            const retry = await hfClient.chatCompletion({
                model: "Qwen/Qwen2.5-7B-Instruct",
                messages: [
                    { role: "system", content: "Rewrite the following text in natural English, keeping it dark, unsettling, and psychologically disturbing:" },
                    { role: "user", content: output }
                ],
                max_tokens: 220
            });
            output = retry?.choices?.[0]?.message?.content?.trim() || output;
        }

        return output;

    } catch (err) {
        console.error("[HF][Cream_In_Agony] API error:", err.message || err);
        return "INFBOT's thoughts twist in shadows… try again?";
    }
}

module.exports = { callAgonyCreamAI };