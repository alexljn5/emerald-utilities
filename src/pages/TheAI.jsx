import PageShell from './PageShell.jsx';
import '../css/the-ai.css';
import { useState, useRef, useEffect } from 'react';
import scaryBunny from '../../img/the-ai/scary_bunny.png';
import { normalizeModelResponse } from '../database/response-normalizer.js';

const STORAGE_KEY = 'ai-chat-messages';
const ACTIVE_CONVERSATION_KEY = 'ai-active-conversation-id';

// Role mapping for display
const ROLE_LABELS = {
    user: 'alexljn5',
    assistant: 'Cream',
    error: 'Error'
};

// Map role to author name for database storage
const ROLE_TO_AUTHOR = {
    user: 'alexljn5',
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
    const outputRef = useRef(null);

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

            // If we have an active conversation ID, try to load it
            if (activeConvId) {
                const convResult = await window.electronAPI.invoke('grok-conversations', { limit: 50 });
                if (convResult?.ok && convResult.conversations?.length > 0) {
                    const activeConv = convResult.conversations.find(c => c.id === activeConvId);
                    if (activeConv) {
                        setConversationId(activeConv.id);
                        const msgResult = await window.electronAPI.invoke('grok-messages', {
                            conversationId: activeConv.id,
                            limit: 100
                        });
                        if (msgResult?.ok && Array.isArray(msgResult.messages)) {
                            const formatted = msgResult.messages.map(msg => ({
                                role: msg.author === 'alexljn5' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
                                content: msg.content,
                                timestamp: msg.timestamp,
                            }));
                            setMessages(formatted);
                            setDbAvailable(true);
                            return;
                        }
                    }
                }
            }

            // Fall back to the most recent conversation
            const convResult = await window.electronAPI.invoke('grok-conversations', { limit: 1 });
            if (convResult?.ok && convResult.conversations?.length > 0) {
                const latestConv = convResult.conversations[0];
                setConversationId(latestConv.id);

                const msgResult = await window.electronAPI.invoke('grok-messages', {
                    conversationId: latestConv.id,
                    limit: 100
                });

                if (msgResult?.ok && Array.isArray(msgResult.messages)) {
                    const formatted = msgResult.messages.map(msg => ({
                        role: msg.author === 'alexljn5' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
                        content: msg.content,
                        timestamp: msg.timestamp,
                    }));
                    setMessages(formatted);
                    setDbAvailable(true);
                    return;
                }
            }

            // Fall back to localStorage if no DB history
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
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

    useEffect(() => {
        if (outputRef.current) {
            // Use requestAnimationFrame to ensure the DOM has fully updated
            // before scrolling to the bottom
            requestAnimationFrame(() => {
                if (outputRef.current) {
                    outputRef.current.scrollTop = outputRef.current.scrollHeight;
                }
            });
        }
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || isRunning) return;

        const userMessage = input.trim();
        const timestamp = new Date().toISOString();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage, timestamp }]);
        setIsRunning(true);

        try {
            const result = await window.electronAPI.invoke('grok-chat', {
                conversationId,
                userMessage,
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

    return (
        <PageShell title="AI" route={route} setRoute={setRoute} leftChildren={
            <div className="aiFace">
                <img src={scaryBunny} alt="Scary Bunny" width="64" height="64" />
            </div>
        }>
            <div className="aiChamber">
                {!dbAvailable && (
                    <div className="aiWarning">
                        <p>Database unavailable. Chat is running in local mode.</p>
                    </div>
                )}
                <div className="aiTerminal" ref={outputRef}>
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
                </div>
            </div>
        </PageShell>
    );
}
