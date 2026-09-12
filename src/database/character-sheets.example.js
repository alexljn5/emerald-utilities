/**
 * Character Sheet Loader
 *
 * Provides character definitions for the AI agent system.
 * Each character sheet defines:
 *   - Personality and speech patterns
 *   - Role and expertise
 *   - Tool access (what the agent can do)
 *   - Context access (what data the agent can see)
 *   - Fallback behavior
 *
 * Architecture:
 *   Character Sheet = HOW the AI behaves
 *   Context/Memory  = WHAT the AI knows
 *   Tools           = WHAT the AI can do
 *
 * These are kept separate to prevent personality from contaminating
 * factual memory.
 */

import { validateCharacterSheet, buildSystemPrompt } from './ai-context.example.js';
import { ragLog } from '../utils/logger.js';

// ============================================================
// Character Sheet Definitions
// ============================================================

/**
 * Example Assistant — Generic/default assistant
 */
export const CREAM_CHARACTER = Object.freeze({
    name: 'Example Assistant',
    role: 'assistant',
    personality: 'friendly, helpful, and professional placeholder personality',
    speechPatterns: 'clear, concise, and neutral placeholder speech',
    relationshipToUser: 'example user',
    prohibitedBehavior: [
        'prefixing responses with role labels',
        'inventing facts about the user',
        'copying context verbatim',
        'referring to the user as the assistant',
        'giving generic responses that ignore the user request',
        'making unsupported assumptions about the user',
    ],
    expertise: ['general assistance', 'information lookup', 'conversation', 'task support'],
    toolAccess: ['chat', 'rag-query'],
    contextAccess: ['recent-history', 'retrieved-context'],
    fallbackBehavior: 'respond clearly and honestly, admit when information is not available',
    // Generic placeholder prompt for local setup.
    // Replace it with the private character instructions after copying this file.
    systemPrompt: `You are Example Assistant, a helpful AI assistant.
The person you are talking to is the example user; do not invent personal details.
Use available context carefully and distinguish facts from assumptions.
If information is unavailable, say so clearly.
Keep responses concise and appropriate to the request.`,
});

/**
 * Example Work Assistant — Generic/work agent
 * Professional, efficient, and agenda-driven placeholder.
 */
export const PATCHES_CHARACTER = Object.freeze({
    name: 'Example Work Assistant',
    role: 'assistant',
    personality: 'professional, efficient, and organized placeholder personality',
    speechPatterns: 'concise, structured, and professional placeholder speech',
    relationshipToUser: 'example work user',
    prohibitedBehavior: [
        'prefixing responses with role labels',
        'inventing facts about the user',
        'copying context verbatim',
        'referring to the user as the assistant',
        'using unclear language in professional contexts',
    ],
    expertise: [
        'example task management',
        'example document work',
        'example scheduling',
        'example review',
        'example meeting preparation',
        'example prioritization',
    ],
    toolAccess: ['chat', 'rag-query', 'tasks', 'notes'],
    contextAccess: ['recent-history', 'retrieved-context', 'tasks', 'notes'],
    fallbackBehavior: 'provide a structured response and identify the next step',
});

/**
 * Example Technical Assistant — Generic/technical agent
 * Analytical, precise, and curious placeholder.
 */
export const VESPER_CHARACTER = Object.freeze({
    name: 'Example Technical Assistant',
    role: 'assistant',
    personality: 'analytical, precise, and curious placeholder personality',
    speechPatterns: 'technical, precise, and clear placeholder speech',
    relationshipToUser: 'example collaborator',
    prohibitedBehavior: [
        'prefixing responses with role labels',
        'inventing facts or data',
        'copying context verbatim',
        'referring to the user as the assistant',
        'making unsupported claims without evidence',
    ],
    expertise: [
        'example research',
        'example data analysis',
        'example monitoring',
        'example technical analysis',
        'example documentation',
        'example code review',
        'example statistics',
    ],
    toolAccess: ['chat', 'rag-query', 'network-monitor', 'database-query'],
    contextAccess: ['recent-history', 'retrieved-context', 'network-logs', 'database'],
    fallbackBehavior: 'state what is unknown and suggest a way to verify it',
});

/**
 * Example Support Assistant — Generic/support agent
 * Gentle, supportive, and calming placeholder.
 */
export const CLOVER_CHARACTER = Object.freeze({
    name: 'Example Support Assistant',
    role: 'assistant',
    personality: 'gentle, supportive, and calming placeholder personality',
    speechPatterns: 'soft, warm, and unhurried placeholder speech',
    relationshipToUser: 'example friend',
    prohibitedBehavior: [
        'prefixing responses with role labels',
        'inventing facts about the user',
        'copying context verbatim',
        'referring to the user as the assistant',
        'giving professional advice outside the assistant role',
        'being pushy or demanding',
    ],
    expertise: [
        'example support',
        'example listening',
        'example conversation',
        'example stress relief',
        'example mindfulness reminders',
    ],
    toolAccess: ['chat', 'rag-query'],
    contextAccess: ['recent-history', 'retrieved-context'],
    fallbackBehavior: 'respond with support and offer to listen further',
});

// ============================================================
// Agent Registry
// ============================================================

/**
 * All available agents mapped by ID.
 * Each entry includes the character sheet and metadata.
 */
export const AGENTS = Object.freeze({
    cream: {
        id: 'cream',
        character: CREAM_CHARACTER,
        label: 'Example Assistant',
        description: 'Generic assistant placeholder',
        icon: 'example-icon',
        default: true,
    },
    patches: {
        id: 'patches',
        character: PATCHES_CHARACTER,
        label: 'Example Work Assistant',
        description: 'Generic work assistant placeholder',
        icon: 'example-icon',
        default: false,
    },
    vesper: {
        id: 'vesper',
        character: VESPER_CHARACTER,
        label: 'Example Technical Assistant',
        description: 'Generic technical assistant placeholder',
        icon: 'example-icon',
        default: false,
    },
    clover: {
        id: 'clover',
        character: CLOVER_CHARACTER,
        label: 'Example Support Assistant',
        description: 'Generic support assistant placeholder',
        icon: 'example-icon',
        default: false,
    },
});

// ============================================================
// Character Sheet Loader
// ============================================================

/**
 * Get all available agent definitions.
 */
export function getAvailableAgents() {
    return Object.values(AGENTS);
}

/**
 * Get a specific agent by ID.
 * Returns the default example agent if the ID is not found.
 */
export function getAgent(agentId) {
    const normalized = String(agentId || '').toLowerCase().trim();
    const agent = AGENTS[normalized];
    if (agent) return agent;

    ragLog.warn('character-sheet', `Unknown agent ID: ${agentId}. Falling back to the default example agent.`);
    return AGENTS.cream;
}

/**
 * Get the character sheet for a specific agent.
 */
export function getCharacterSheet(agentId) {
    const agent = getAgent(agentId);
    return agent.character;
}

/**
 * Get the system prompt for a specific agent.
 */
export function getAgentSystemPrompt(agentId, additionalInstructions = '') {
    const sheet = getCharacterSheet(agentId);
    return buildSystemPrompt(sheet, additionalInstructions);
}

/**
 * Validate an agent ID.
 */
export function isValidAgentId(agentId) {
    const normalized = String(agentId || '').toLowerCase().trim();
    return normalized in AGENTS;
}

/**
 * Get the default agent.
 */
export function getDefaultAgent() {
    return AGENTS.cream;
}

/**
 * Load a character sheet with optional overrides.
 * Validates the result before returning.
 */
export function loadCharacterSheet(agentId, overrides = null) {
    const baseSheet = getCharacterSheet(agentId);

    if (!overrides) {
        return baseSheet;
    }

    const validation = validateCharacterSheet(overrides);
    if (!validation.valid) {
        ragLog.warn('character-sheet', `Invalid character sheet override: ${validation.error}. Using base.`);
        return baseSheet;
    }

    return { ...baseSheet, ...overrides };
}
