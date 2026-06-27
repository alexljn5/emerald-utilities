/**
 * DATABASE.JS - IndexedDB JSON Storage Layer
 * Lightweight local-first storage for scraped X/Grok messages
 */

class XScraperDatabase {
    constructor() {
        this.dbName = 'XScraper';
        this.version = 1;
        this.db = null;
        this.initialized = false;

        // track last export for incremental JSON dumps
        this.lastExportTimestamp = 0;
    }

    /**
     * Initialize IndexedDB
     */
    async init() {
        if (this.initialized) return this.db;

        this.db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('messages')) {
                    const store = db.createObjectStore('messages', { keyPath: 'id' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('conversationId', 'conversationId', { unique: false });
                }

                if (!db.objectStoreNames.contains('conversations')) {
                    db.createObjectStore('conversations', { keyPath: 'id' });
                }
            };
        });

        this.initialized = true;
        return this.db;
    }

    /**
     * Save single message
     */
    async saveMessage(message) {
        await this.init();

        const msg = {
            ...message,
            id: message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            savedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['messages'], 'readwrite');
            const store = tx.objectStore('messages');

            const req = store.put(msg); // put = upsert (prevents duplicates)

            req.onsuccess = () => resolve(msg);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Save multiple messages (batch safe)
     */
    async saveMessages(messages = []) {
        await this.init();

        const results = [];

        for (const message of messages) {
            try {
                const saved = await this.saveMessage(message);
                results.push(saved);
            } catch (e) {
                console.warn('[XSCRAPER_DB] Failed to save message:', e);
            }
        }

        return results;
    }

    /**
     * Get all messages
     */
    async getAllMessages() {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['messages'], 'readonly');
            const store = tx.objectStore('messages');

            const req = store.getAll();

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get messages by conversation
     */
    async getMessagesByConversation(conversationId) {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['messages'], 'readonly');
            const store = tx.objectStore('messages');
            const index = store.index('conversationId');

            const req = index.getAll(conversationId);

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Save conversation metadata
     */
    async saveConversation(conversation) {
        await this.init();

        const conv = {
            ...conversation,
            savedAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['conversations'], 'readwrite');
            const store = tx.objectStore('conversations');

            const req = store.put(conv);

            req.onsuccess = () => resolve(conv);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Get all conversations
     */
    async getAllConversations() {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['conversations'], 'readonly');
            const store = tx.objectStore('conversations');

            const req = store.getAll();

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Count messages
     */
    async getMessageCount() {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['messages'], 'readonly');
            const store = tx.objectStore('messages');

            const req = store.count();

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Clear all data
     */
    async clearAll() {
        await this.init();

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['messages', 'conversations'], 'readwrite');

            tx.objectStore('messages').clear();
            tx.objectStore('conversations').clear();

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * FULL JSON EXPORT
     */
    async exportAsJSON() {
        const messages = await this.getAllMessages();
        const conversations = await this.getAllConversations();

        const exportData = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            totalMessages: messages.length,
            totalConversations: conversations.length,
            messages,
            conversations
        };

        this.lastExportTimestamp = Date.now();

        return exportData;
    }

    /**
     * INCREMENTAL EXPORT (only new messages)
     */
    async exportIncrementalJSON() {
        const messages = await this.getAllMessages();

        const newMessages = messages.filter(
            m => (m.savedAt || 0) > this.lastExportTimestamp
        );

        const exportData = {
            version: '1.0',
            exportDate: new Date().toISOString(),
            lastExportTimestamp: this.lastExportTimestamp,
            newMessages: newMessages.length,
            messages: newMessages
        };

        this.lastExportTimestamp = Date.now();

        return exportData;
    }

    /**
     * Download JSON file (browser-controlled folder)
     */
    async downloadJSON(data, filenamePrefix = 'x_export') {
        const json = JSON.stringify(data, null, 2);

        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${filenamePrefix}_${Date.now()}.json`;

        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
    }
}

// Singleton
const xScraperDatabase = new XScraperDatabase();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = xScraperDatabase;
}