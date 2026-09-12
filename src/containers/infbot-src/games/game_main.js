const db = require('./db');

class Game {
    constructor() {
        this.players = new Map();
        this.tickInterval = 5000;
        this.startLoop();
        console.log('[Game] Engine initialized');
    }

    startLoop() {
        this.loop = setInterval(() => this.tick(), this.tickInterval);
    }

    tick() {
        console.log(`[Game] Tick: ${this.players.size} active players`);

        for (const [id, player] of this.players) {
            // Passive HP regen
            player.hp = Math.min(player.maxHp, player.hp + 1);
        }
    }

    async addPlayer(userId) {
        if (this.players.has(userId)) return;

        console.log(`[Game] Loading player ${userId}`);

        try {
            const res = await db.query(
                'SELECT * FROM players WHERE userId = ?',
                [userId]
            );

            let player;

            if (res.length > 0) {
                const dbPlayer = res[0];

                player = {
                    hp: 10,
                    maxHp: 10,
                    neocreds: dbPlayer.neocreds || 0,
                    job: dbPlayer.job || null,
                    inventory: JSON.parse(dbPlayer.inventory || '[]')
                };

                console.log(`[Game] Player ${userId} loaded from DB`);
            } else {
                player = {
                    hp: 10,
                    maxHp: 10,
                    neocreds: 0,
                    job: null,
                    inventory: []
                };

                await db.query(
                    'INSERT INTO players (userId, neocreds, inventory) VALUES (?, ?, ?)',
                    [userId, 0, JSON.stringify([])]
                );

                console.log(`[Game] New player ${userId} created`);
            }

            this.players.set(userId, player);

        } catch (err) {
            console.error('[Game] addPlayer failed:', err);
            throw err;
        }
    }

    async savePlayer(userId) {
        const player = this.players.get(userId);
        if (!player) return;

        try {
            await db.query(
                `UPDATE players 
                 SET neocreds = ?, job = ?, inventory = ? 
                 WHERE userId = ?`,
                [
                    player.neocreds,
                    player.job,
                    JSON.stringify(player.inventory),
                    userId
                ]
            );

            console.log(`[Game] Player ${userId} saved`);
        } catch (err) {
            console.error('[Game] savePlayer failed:', err);
        }
    }

    async handleCommand(userId, command, args) {
        await this.addPlayer(userId);

        const player = this.players.get(userId);

        console.log(`[Game] ${userId} -> ${command}`, args);

        switch (command) {
            case 'heal':
                player.hp = Math.min(player.maxHp, player.hp + 5);
                await this.savePlayer(userId);
                return `You healed! HP: ${player.hp}/${player.maxHp}`;

            case 'status':
                return `HP: ${player.hp}/${player.maxHp} | NeoCreds: ${player.neocreds}`;

            case 'work':
                const earned = Math.floor(Math.random() * 10) + 5;
                player.neocreds += earned;

                await this.savePlayer(userId);

                return `You worked and earned ${earned} NeoCreds.\nTotal: ${player.neocreds}`;

            case 'debug':
                return '```json\n' + JSON.stringify(player, null, 2) + '\n```';

            default:
                return `Unknown action: ${command}`;
        }
    }
}

module.exports = new Game();