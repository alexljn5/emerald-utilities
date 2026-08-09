/**
 * Express Server with Auto-Sync Engine
 * Runs on localhost:3000
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const Database = require('./database');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Configuration
let CONFIG = {
    outputFolder: path.join(process.env.APPDATA || process.env.HOME, '.xscraper'),
    autoSyncInterval: 60 * 1000, // 1 minute (can be configured to 24/7 monitoring)
    database: null
};

let db = null;
let autoSyncTimer = null;
let autoSyncActive = false;

/**
 * Initialize configuration
 */
async function initializeConfig() {
    const configPath = path.join(CONFIG.outputFolder, 'config.json');

    if (fs.existsSync(configPath)) {
        try {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            CONFIG = { ...CONFIG, ...saved };
        } catch (err) {
            console.error('Error loading config:', err);
        }
    }

    // Create output folder if it doesn't exist
    if (!fs.existsSync(CONFIG.outputFolder)) {
        fs.mkdirSync(CONFIG.outputFolder, { recursive: true });
    }

    saveConfig();
    console.log('Output folder:', CONFIG.outputFolder);
}

/**
 * Save configuration to file
 */
function saveConfig() {
    const configPath = path.join(CONFIG.outputFolder, 'config.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            outputFolder: CONFIG.outputFolder,
            autoSyncInterval: CONFIG.autoSyncInterval
        }, null, 2)
    );
}

/**
 * Initialize database
 */
async function initializeDatabase() {
    const dbPath = path.join(CONFIG.outputFolder, 'x_messages.db');
    db = new Database(dbPath);
    await db.initialize();
    console.log('Database ready!');
}

/**
 * AUTO-SYNC ENGINE: Monitors for new messages 24/7
 */
async function autoSyncMessages() {
    if (!autoSyncActive) {
        console.log('Auto-sync paused or disabled');
        return;
    }

    try {
        console.log(`[AUTO-SYNC] Running at ${new Date().toISOString()}`);

        const conversations = await db.getAllConversations();
        console.log(`[AUTO-SYNC] Checking ${conversations.length} conversations`);

        for (const conv of conversations) {
            // Here you would typically:
            // 1. Connect to browser extension to trigger scrape
            // 2. Compare new messages with database
            // 3. Auto-save any new messages

            console.log(`[AUTO-SYNC] Monitored conversation: ${conv.id}`);
        }
    } catch (error) {
        console.error('[AUTO-SYNC] Error:', error);
    }
}

/**
 * Start auto-sync engine
 */
function startAutoSync(intervalMs = null) {
    if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
    }

    const interval = intervalMs || CONFIG.autoSyncInterval;
    autoSyncActive = true;

    console.log(`Auto-sync started (interval: ${interval}ms)`);
    autoSyncTimer = setInterval(autoSyncMessages, interval);

    // Run once immediately
    autoSyncMessages();
}

/**
 * Stop auto-sync engine
 */
function stopAutoSync() {
    if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
        autoSyncTimer = null;
    }
    autoSyncActive = false;
    console.log('Auto-sync stopped');
}

// ============ API ROUTES ============

/**
 * Health check
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        autoSyncActive,
        outputFolder: CONFIG.outputFolder
    });
});

/**
 * Get configuration
 */
app.get('/config', (req, res) => {
    res.json(CONFIG);
});

/**
 * Update output folder
 */
app.post('/config/output-folder', (req, res) => {
    const { folder } = req.body;

    if (!folder) {
        return res.status(400).json({ error: 'Folder path required' });
    }

    try {
        // Create folder if it doesn't exist
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }

        CONFIG.outputFolder = folder;
        saveConfig();

        res.json({
            success: true,
            message: 'Output folder updated',
            folder: CONFIG.outputFolder
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Save messages from extension
 */
app.post('/api/messages/save', async (req, res) => {
    try {
        const { messages, conversationId, conversationTitle } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages array required' });
        }

        if (!conversationId) {
            return res.status(400).json({ error: 'Conversation ID required' });
        }

        const result = await db.saveMessages(messages, conversationId, conversationTitle);

        res.json(result);
    } catch (error) {
        console.error('Error saving messages:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get all conversations
 */
app.get('/api/conversations', async (req, res) => {
    try {
        const conversations = await db.getAllConversations();
        res.json(conversations);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get messages by conversation
 */
app.get('/api/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 1000, offset = 0 } = req.query;

        const messages = await db.getMessagesByConversation(id, parseInt(limit), parseInt(offset));
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get recent messages
 */
app.get('/api/messages/recent', async (req, res) => {
    try {
        const { hours = 24, limit = 100 } = req.query;
        const messages = await db.getRecentMessages(parseInt(hours), parseInt(limit));
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Check for duplicates (used by auto-sync)
 */
app.post('/api/messages/check-duplicates', async (req, res) => {
    try {
        const { conversationId, messageContents } = req.body;

        if (!conversationId || !messageContents) {
            return res.status(400).json({ error: 'conversationId and messageContents required' });
        }

        const duplicates = await db.checkDuplicates(conversationId, messageContents);
        const newMessages = messageContents.filter(m => !duplicates.includes(m));

        res.json({
            totalChecked: messageContents.length,
            duplicatesFound: duplicates.length,
            newMessages: newMessages.length,
            duplicates,
            newMessagesList: newMessages
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Export all data as JSON
 */
app.get('/api/export', async (req, res) => {
    try {
        const { conversationId } = req.query;
        const data = await db.exportAsJSON(conversationId);

        // Generate filename
        const timestamp = new Date().toISOString().split('T')[0];
        const filename = conversationId
            ? `x_messages_${conversationId}_${timestamp}.json`
            : `x_messages_${timestamp}.json`;

        // Save to output folder
        const exportPath = path.join(CONFIG.outputFolder, filename);
        fs.writeFileSync(exportPath, JSON.stringify(data, null, 2));

        res.json({
            success: true,
            data,
            savedTo: exportPath
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Download export file
 */
app.get('/api/export/download/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const filepath = path.join(CONFIG.outputFolder, filename);

        // Security: prevent directory traversal
        if (!filepath.startsWith(CONFIG.outputFolder)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.download(filepath);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get database statistics
 */
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.getStats();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Control auto-sync
 */
app.post('/api/sync/start', (req, res) => {
    const { intervalMs } = req.body;
    startAutoSync(intervalMs);
    res.json({ message: 'Auto-sync started', active: autoSyncActive });
});

app.post('/api/sync/stop', (req, res) => {
    stopAutoSync();
    res.json({ message: 'Auto-sync stopped', active: autoSyncActive });
});

app.get('/api/sync/status', (req, res) => {
    res.json({
        active: autoSyncActive,
        interval: CONFIG.autoSyncInterval,
        lastCheck: new Date().toISOString()
    });
});

// ============ ERROR HANDLING ============

app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ============ SERVER STARTUP ============

async function start() {
    try {
        console.log('Starting XScraper Server...\n');

        await initializeConfig();
        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`\n✓ Server running on http://localhost:${PORT}`);
            console.log(`✓ Database: ${path.join(CONFIG.outputFolder, 'x_messages.db')}`);
            console.log(`✓ Output folder: ${CONFIG.outputFolder}`);
            console.log('\nAvailable endpoints:');
            console.log('  GET  /health                    - Server status');
            console.log('  GET  /config                    - Get configuration');
            console.log('  POST /config/output-folder      - Set output folder');
            console.log('  POST /api/messages/save         - Save messages from extension');
            console.log('  GET  /api/conversations         - List all conversations');
            console.log('  GET  /api/conversations/:id/messages - Get messages');
            console.log('  GET  /api/messages/recent       - Get recent messages');
            console.log('  POST /api/messages/check-duplicates - Check for new messages');
            console.log('  GET  /api/export                - Export all data');
            console.log('  GET  /api/stats                 - Database statistics');
            console.log('  POST /api/sync/start            - Start auto-sync');
            console.log('  POST /api/sync/stop             - Stop auto-sync');
            console.log('  GET  /api/sync/status           - Check auto-sync status');
            console.log('\nServer is ready to receive messages from the Firefox extension!\n');

            // Start auto-sync by default
            startAutoSync(60000); // Check every 60 seconds
        });

        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\n\nShutting down...');
            stopAutoSync();
            await db.close();
            process.exit(0);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();