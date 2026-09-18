import PageShell from './PageShell.jsx';
import '../css/the-ai.css';
import { useState, useRef, useEffect } from 'react';
import scaryBunny from '../../img/the-ai/scary_bunny.png';
import { normalizeModelResponse } from '../database/response-normalizer.js';
import { getAvailableAgents, getAgent, isValidAgentId } from '../database/character-sheets.js';

const STORAGE_KEY = 'ai-chat-messages';
const ACTIVE_CONVERSATION_KEY = 'ai-active-conversation-id';
const DEBUG_MODE_KEY = 'ai-debug-mode';
const SELECTED_AGENT_KEY = 'ai-selected-agent';

// Role mapping for display
const ROLE_LABELS = {
    user: 'emerald-user',
    assistant: 'Cream',
    error: 'Error'
};

// Map role to author name for database storage
const ROLE_TO_AUTHOR = {
    user: 'emerald-user',
    assistant: 'Cream',
    error: 'Error'
};

export default function TheAI({ route, setRoute }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isRunning, setIsRunning] = useState(false);
    const [isSettingUp, setIsSettingUp] = useState(false);
    const [autoSaveChat, setAutoSaveChat] = useState(true);
    const [conversationId, setConversationId] = useState(null);
    const [dbAvailable, setDbAvailable] = useState(true);
    const [debugMode, setDebugMode] = useState(false);
    const [lastContextDebug, setLastContextDebug] = useState(null);
    const [selectedAgent, setSelectedAgent] = useState('cream');
    const [availableAgents, setAvailableAgents] = useState([]);
    const outputRef = useRef(null);
    const shouldAutoScroll = useRef(true);

    // Load available agents
    useEffect(() => {
        const agents = getAvailableAgents();
        setAvailableAgents(agents);
    }, []);

    // Load selected agent from localStorage
    useEffect(() => {
        try {
            const savedAgent = localStorage.getItem(SELECTED_AGENT_KEY);
            if (savedAgent && isValidAgentId(savedAgent)) {
                setSelectedAgent(savedAgent);
            }
        } catch (e) {
            console.warn('[AI] Failed to load selected agent:', e);
        }
    }, []);

    // Load auto-save setting and chat history on mount
    useEffect(() => {
        // Load auto-save setting
        window.electronAPI?.invoke('settings:get')
            .then(result => {
                if (result?.ok && typeof result.ui?.autoSaveChat === 'boolean') {
                    setAutoSaveChat(result.ui.autoSaveChat);
                }
            })
            .catch(() => {
                // Default to true if settings can't be loaded
                setAutoSaveChat(true);
            });

        // Load debug mode preference
        try {
            const savedDebug = localStorage.getItem(DEBUG_MODE_KEY);
            if (savedDebug) setDebugMode(JSON.parse(savedDebug));
        } catch (e) {
            console.warn('[AI] Failed to load debug mode:', e);
        }

        // Load chat history from PostgreSQL (primary source)
        loadChatHistory();
    }, []);

    async function loadChatHistory() {
        try {
            // Try to restore the active conversation ID from localStorage
            let activeConvId = null;
            try {
                const saved = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
                if (saved) activeConvId = JSON.parse(saved);
            } catch (e) {
                console.warn('[AI] Failed to load active conversation ID:', e);
            }

            console.log('[AI] Loading chat history, activeConvId:', activeConvId);

            // If we have an active conversation ID, try to load it directly
            // This avoids the problem where the active conversation is not in the
            // first 50 results from grok-conversations.
            if (activeConvId) {
                console.log('[AI] Attempting direct load of active conversation:', activeConvId);
                const msgResult = await window.electronAPI.invoke('grok-messages', {
                    conversationId: activeConvId,
                });
                console.log('[AI] Direct grok-messages result:', msgResult?.ok ? `${msgResult.messages?.length} messages` : msgResult?.error);
                if (msgResult?.ok && Array.isArray(msgResult.messages) && msgResult.messages.length > 0) {
                    setConversationId(activeConvId);
                    const formatted = msgResult.messages.map(msg => ({
                        role: msg.author === 'emerald-user' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
                        content: msg.author === 'Cream' ? normalizeModelResponse(msg.content) : msg.content,
                        timestamp: msg.timestamp,
                    }));
                    console.log('[AI] Loaded', formatted.length, 'messages for active conversation', activeConvId);
                    setMessages(formatted);
                    setDbAvailable(true);
                    return;
                }
                console.log('[AI] Active conversation not found or empty, clearing stale ID');
                // Clear stale conversation ID from localStorage
                try {
                    localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
                } catch (e) {
                    console.warn('[AI] Failed to clear stale conversation ID:', e);
                }
            }

            // Fall back to the most recent conversation
            const convResult = await window.electronAPI.invoke('grok-conversations', { limit: 1 });
            console.log('[AI] Fallback grok-conversations result:', convResult?.ok ? `${convResult.conversations?.length} conversations` : convResult?.error);
            if (convResult?.ok && convResult.conversations?.length > 0) {
                const latestConv = convResult.conversations[0];
                console.log('[AI] Using most recent conversation:', latestConv.id, latestConv.title);
                setConversationId(latestConv.id);

                const msgResult = await window.electronAPI.invoke('grok-messages', {
                    conversationId: latestConv.id,
                });
                console.log('[AI] Fallback grok-messages result:', msgResult?.ok ? `${msgResult.messages?.length} messages` : msgResult?.error);

                if (msgResult?.ok && Array.isArray(msgResult.messages)) {
                    const formatted = msgResult.messages.map(msg => ({
                        role: msg.author === 'emerald-user' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
                        content: msg.author === 'Cream' ? normalizeModelResponse(msg.content) : msg.content,
                        timestamp: msg.timestamp,
                    }));
                    console.log('[AI] Loaded', formatted.length, 'messages for conversation', latestConv.id);
                    setMessages(formatted);
                    setDbAvailable(true);
                    return;
                }
            }

            // Fall back to localStorage if no DB history
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
                    console.log('[AI] Falling back to localStorage:', JSON.parse(saved).length, 'messages');
                    setMessages(JSON.parse(saved));
                }
            } catch (e) {
                console.warn('[AI] Failed to load messages from localStorage:', e);
            }
        } catch (e) {
            console.warn('[AI] Failed to load chat history from database:', e);
            setDbAvailable(false);

            // Fall back to localStorage
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
                    setMessages(JSON.parse(saved));
                }
            } catch (e) {
                console.warn('[AI] Failed to load messages from localStorage:', e);
            }
        }
    }

    // Auto-setup RAG on component mount
    useEffect(() => {
        const runAutoSetup = async () => {
            setIsSettingUp(true);
            try {
                const result = await window.electronAPI.invoke('rag-auto-setup');
                if (result.ok) {
                    console.log('[AI] RAG auto-setup complete:', result.status);
                } else {
                    console.error('[AI] RAG auto-setup failed:', result.error);
                }
            } catch (error) {
                console.error('[AI] RAG auto-setup error:', error);
            } finally {
                setIsSettingUp(false);
            }
        };
        runAutoSetup();
    }, []);

    // Persist messages to localStorage
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
        } catch (e) {
            console.warn('[AI] Failed to persist messages:', e);
        }
    }, [messages, autoSaveChat]);

    // Persist selected agent
    useEffect(() => {
        try {
            localStorage.setItem(SELECTED_AGENT_KEY, selectedAgent);
        } catch (e) {
            console.warn('[AI] Failed to persist selected agent:', e);
        }
    }, [selectedAgent]);

    // Persist debug mode preference
    useEffect(() => {
        try {
            localStorage.setItem(DEBUG_MODE_KEY, JSON.stringify(debugMode));
        } catch (e) {
            console.warn('[AI] Failed to persist debug mode:', e);
        }
    }, [debugMode]);

    // Track whether user is near the bottom so we only auto-scroll
    // when appropriate (e.g. on new messages, not when reading history).
    const handleScroll = () => {
        if (!outputRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
        // Consider "near bottom" if within 150px of the bottom
        shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 150;
    };

    // Always scroll to bottom when messages change or on initial load.
    // Uses a small timeout to ensure the DOM has rendered the new messages
    // before measuring scrollHeight.
    useEffect(() => {
        if (outputRef.current) {
            const timer = setTimeout(() => {
                if (outputRef.current) {
                    outputRef.current.scrollTop = outputRef.current.scrollHeight;
                }
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [messages]);

    // Auto-scroll to bottom on window/container resize when user is near bottom.
    // This fixes the "have to scroll down after resizing window" annoyance.
    useEffect(() => {
        if (!outputRef.current) return;

        const resizeObserver = new ResizeObserver(() => {
            if (!outputRef.current || !shouldAutoScroll.current) return;
            // Use requestAnimationFrame to ensure layout is settled
            requestAnimationFrame(() => {
                if (outputRef.current && shouldAutoScroll.current) {
                    outputRef.current.scrollTop = outputRef.current.scrollHeight;
                }
            });
        });

        resizeObserver.observe(outputRef.current);

        return () => resizeObserver.disconnect();
    }, []);

    const handleSend = async () => {
        if (!input.trim() || isRunning) return;

        const userMessage = input.trim();
        const timestamp = new Date().toISOString();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage, timestamp }]);
        setIsRunning(true);

        // Enable auto-scroll when user sends a message
        shouldAutoScroll.current = true;

        try {
            const result = await window.electronAPI.invoke('grok-chat', {
                conversationId,
                userMessage,
                agentId: selectedAgent,
                timeoutMs: 120000,
            });

            if (result.ok) {
                const cleanedResponse = normalizeModelResponse(result.response);
                setMessages(prev => [...prev, { role: 'assistant', content: cleanedResponse, timestamp: new Date().toISOString() }]);
                setConversationId(result.conversationId);
                // Persist active conversation ID for next app restart
                try {
                    localStorage.setItem(ACTIVE_CONVERSATION_KEY, JSON.stringify(result.conversationId));
                } catch (e) {
                    console.warn('[AI] Failed to persist active conversation ID:', e);
                }
                setDbAvailable(true);

                // Store context debug info if available
                if (result.contextDebug && debugMode) {
                    setLastContextDebug(result.contextDebug);
                }
            } else {
                setMessages(prev => [...prev, { role: 'error', content: result.error, timestamp: new Date().toISOString() }]);
                if (result.unavailable === 'database') {
                    setDbAvailable(false);
                }
            }
        } catch (error) {
            setMessages(prev => [...prev, { role: 'error', content: error.message, timestamp: new Date().toISOString() }]);
        } finally {
            setIsRunning(false);
        }
    };

    const toggleDebugMode = async () => {
        const newMode = !debugMode;
        setDebugMode(newMode);

        // Fetch debug context for current conversation if enabling debug
        if (newMode && conversationId) {
            try {
                const result = await window.electronAPI.invoke('grok-debug-context', {
                    conversationId,
                    limit: 20,
                    agentId: selectedAgent,
                });
                if (result.ok) {
                    setLastContextDebug(result.debugView);
                }
            } catch (e) {
                console.warn('[AI] Failed to fetch debug context:', e);
            }
        } else {
            setLastContextDebug(null);
        }
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleClearChat = async () => {
        if (confirm('Clear all chat messages?')) {
            if (conversationId) {
                try {
                    await window.electronAPI.invoke('grok-clear-conversation', { conversationId });
                } catch (e) {
                    console.warn('[AI] Failed to clear database messages:', e);
                }
            }
            setMessages([]);
            setConversationId(null);
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (e) {
                console.warn('[AI] Failed to clear persisted messages:', e);
            }
        }
    };

    const handleNewConversation = async () => {
        setConversationId(null);
        setMessages([]);
        try {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        } catch (e) {
            console.warn('[AI] Failed to clear persisted messages:', e);
        }
    };

    const renderDebugPanel = () => {
        if (!debugMode) return null;

        const debugInfo = lastContextDebug || {
            summary: 'Send a message to see context debug info',
            details: [],
        };

        // Build details array from the new debug summary format
        let details = debugInfo.details || [];
        if (!details.length && debugInfo.sources) {
            details = Object.entries(debugInfo.sources).map(([source, count]) => ({
                source: source.charAt(0).toUpperCase() + source.slice(1),
                count,
                tokens: '-',
                preview: '-',
            }));
        }

        return (
            <div className="aiDebugPanel">
                <div className="aiDebugHeader">
                    <h4>AI Context Debug</h4>
                    <button onClick={toggleDebugMode} className="aiDebugClose">×</button>
                </div>
                <div className="aiDebugContent">
                    {debugInfo.contextMode && (
                        <div className="aiDebugSummary">
                            <strong>Mode:</strong> {debugInfo.contextMode} |
                            <strong> Budget:</strong> {debugInfo.maxTokens?.toLocaleString?.() || debugInfo.maxTokens} tokens |
                            <strong> Used:</strong> {debugInfo.totalTokens?.toLocaleString?.() || debugInfo.totalTokens} tokens ({debugInfo.utilization}%) |
                            <strong> Reserved:</strong> {debugInfo.reservedOutputTokens?.toLocaleString?.() || debugInfo.reservedOutputTokens} output tokens
                        </div>
                    )}
                    {debugInfo.omittedCount > 0 && (
                        <div className="aiDebugSummary" style={{ color: '#ff6b6b' }}>
                            <strong>Omitted:</strong> {debugInfo.omittedCount} messages ({debugInfo.omittedRecentCount} recent) could not fit in context.
                        </div>
                    )}
                    {debugInfo.summary && (
                        <div className="aiDebugSummary">
                            <strong>Summary:</strong> {typeof debugInfo.summary === 'string' ? debugInfo.summary : JSON.stringify(debugInfo.summary)}
                        </div>
                    )}
                    {details.length > 0 && (
                        <div className="aiDebugDetails">
                            <strong>Context Sources:</strong>
                            {details.map((detail, i) => (
                                <div key={i} className="aiDebugDetail">
                                    <span className="aiDebugSource">{detail.source}</span>
                                    <span className="aiDebugMeta">{detail.count} msgs, {detail.tokens} tokens</span>
                                    <div className="aiDebugPreview">{detail.preview}</div>
                                </div>
                            ))}
                        </div>
                    )}
                    {!details.length && (
                        <div className="aiDebugEmpty">No context details available</div>
                    )}
                </div>
            </div>
        );
    };

    const handleAgentChange = (e) => {
        const newAgent = e.target.value;
        if (isValidAgentId(newAgent)) {
            setSelectedAgent(newAgent);
            const agent = getAgent(newAgent);
            if (agent) {
                console.log('[AI] Switched to agent:', agent.name, '-', agent.role);
            }
        }
    };

    const currentAgent = getAgent(selectedAgent);

    const isCream = selectedAgent === 'cream';

    return (
        <PageShell title="AI" route={route} setRoute={setRoute} leftChildren={
            <div className="aiFace">
                <img src={scaryBunny} alt="Scary Bunny" width="64" height="64" />
            </div>
        }>
            <div className="aiChamber">
                <div className="aiAgentSelector">
                    <label htmlFor="agent-select">Agent:</label>
                    <select
                        id="agent-select"
                        value={selectedAgent}
                        onChange={handleAgentChange}
                        disabled={isRunning}
                        title="Select AI agent personality"
                    >
                        {availableAgents.map(agent => (
                            <option key={agent.id} value={agent.id}>
                                {agent.label || agent.id}
                            </option>
                        ))}
                    </select>
                </div>
                {!isCream ? (
                    <div className="aiWelcome">
                        <p className="aiQuestion">{currentAgent?.label ? currentAgent.label.toUpperCase() : currentAgent?.id?.toUpperCase() || 'AGENT'}</p>
                        <p className="aiHint">This agent is not yet available.</p>
                    </div>
                ) : (
                    <>
                        {!dbAvailable && (
                            <div className="aiWarning">
                                <p>Database unavailable. Chat is running in local mode.</p>
                            </div>
                        )}
                        <div className="aiTerminal" ref={outputRef} onScroll={handleScroll}>
                            {isSettingUp ? (
                                <div className="aiWelcome">
                                    <p className="aiQuestion">SETTING UP RAG...</p>
                                    <p className="aiHint">Loading context from Grok messages...</p>
                                </div>
                            ) : messages.length === 0 ? (
                                <div className="aiWelcome">
                                    <p className="aiQuestion">GROK TERMINAL READY</p>
                                    <p className="aiHint">Type your message below to query Grok...</p>
                                </div>
                            ) : (
                                messages.map((msg, i) => (
                                    <div key={i} className={`aiMessage aiMessage--${msg.role}`}>
                                        <span className="aiMessageLabel">{ROLE_LABELS[msg.role] || msg.role}:</span>
                                        <span className="aiMessageContent">{msg.content}</span>
                                    </div>
                                ))
                            )}
                        </div>
                        <div className="aiInput">
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyPress={handleKeyPress}
                                placeholder="Type your message to Cream..."
                                disabled={isRunning}
                                rows={3}
                            />
                            <button onClick={handleSend} disabled={isRunning || !input.trim()}>
                                {isRunning ? 'SENDING...' : 'SEND'}
                            </button>
                            {messages.length > 0 && (
                                <button
                                    onClick={handleClearChat}
                                    disabled={isRunning}
                                    className="aiClearBtn"
                                >
                                    CLEAR
                                </button>
                            )}
                            <button
                                onClick={handleNewConversation}
                                disabled={isRunning}
                                className="aiNewConvBtn"
                            >
                                NEW CONVERSATION
                            </button>
                            <button
                                onClick={toggleDebugMode}
                                disabled={isRunning}
                                className={`aiDebugBtn ${debugMode ? 'aiDebugBtn--active' : ''}`}
                                title="Toggle AI context debug view"
                            >
                                {debugMode ? 'DEBUG ON' : 'DEBUG'}
                            </button>
                        </div>
                        {renderDebugPanel()}
                    </>
                )}
            </div>
        </PageShell>
    );
}
