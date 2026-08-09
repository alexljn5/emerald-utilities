import path from 'path';

const MINUTE_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function createId() {
    return `archive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeIntervalMinutes(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 60;
    return Math.max(1, Math.floor(number));
}

function normalizeTask(input = {}) {
    const intervalMinutes = normalizeIntervalMinutes(input.intervalMinutes);
    const now = Date.now();
    const nextRunAt = Date.parse(input.nextRunAt || '');

    return {
        id: typeof input.id === 'string' && input.id ? input.id : createId(),
        label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : 'Archive task',
        action: ['backup', 'verify', 'metadata-sync'].includes(input.action) ? input.action : 'backup',
        enabled: input.enabled !== false,
        intervalMinutes,
        notifyOnStart: input.notifyOnStart !== false,
        notifyOnSuccess: input.notifyOnSuccess !== false,
        notifyOnError: input.notifyOnError !== false,
        runMissedOnBoot: input.runMissedOnBoot !== false,
        nextRunAt: Number.isFinite(nextRunAt) ? new Date(nextRunAt).toISOString() : new Date(now + intervalMinutes * MINUTE_MS).toISOString(),
        lastRunAt: input.lastRunAt || null,
        lastStatus: input.lastStatus || 'pending',
        lastError: input.lastError || '',
        createdAt: input.createdAt || new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString()
    };
}

export class ArchiveScheduler {
    constructor({ storagePath, fsPromises, runAction, notify }) {
        this.storagePath = storagePath;
        this.fsPromises = fsPromises;
        this.runAction = runAction;
        this.notify = notify;
        this.tasks = new Map();
        this.timers = new Map();
        this.running = new Set();
        this.writeQueue = Promise.resolve();
    }

    async start() {
        await this.load();
        for (const task of this.tasks.values()) {
            this.arm(task);
            if (task.enabled && task.runMissedOnBoot && Date.parse(task.nextRunAt) <= Date.now()) {
                queueMicrotask(() => this.execute(task.id, 'missed-deadline'));
            }
        }
    }

    async load() {
        try {
            const raw = await this.fsPromises.readFile(this.storagePath, 'utf8');
            const data = JSON.parse(raw);
            for (const task of data.tasks || []) {
                const normalized = normalizeTask(task);
                this.tasks.set(normalized.id, normalized);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('[ArchiveScheduler] Failed to load:', err.message);
            }
        }
    }

    async persist() {
        const payload = { version: 1, tasks: this.list() };
        this.writeQueue = this.writeQueue.then(async () => {
            await this.fsPromises.mkdir(path.dirname(this.storagePath), { recursive: true });
            await this.fsPromises.writeFile(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
        }, async () => {
            await this.fsPromises.mkdir(path.dirname(this.storagePath), { recursive: true });
            await this.fsPromises.writeFile(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
        });
        return this.writeQueue;
    }

    list() {
        return Array.from(this.tasks.values()).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
    }

    async upsert(input) {
        const existing = input?.id ? this.tasks.get(input.id) : null;
        const task = normalizeTask({ ...existing, ...input });
        this.tasks.set(task.id, task);
        this.arm(task);
        await this.persist();
        return task;
    }

    async remove(id) {
        this.disarm(id);
        const deleted = this.tasks.delete(id);
        await this.persist();
        return deleted;
    }

    disarm(id) {
        const timer = this.timers.get(id);
        if (timer) clearTimeout(timer);
        this.timers.delete(id);
    }

    arm(task) {
        this.disarm(task.id);
        if (!task.enabled) return;
        const delay = Math.max(0, Date.parse(task.nextRunAt) - Date.now());
        const timer = setTimeout(() => this.execute(task.id, 'scheduled'), Math.min(delay, MAX_TIMEOUT_MS));
        this.timers.set(task.id, timer);
    }

    async execute(id, trigger = 'manual') {
        const task = this.tasks.get(id);
        if (!task || this.running.has(id)) return task || null;

        this.running.add(id);
        if (task.notifyOnStart) this.notify({ type: 'info', title: 'Archive Started', message: task.label, taskId: id, trigger });

        try {
            await this.runAction(task.action, task);
            task.lastStatus = 'success';
            task.lastError = '';
            if (task.notifyOnSuccess) this.notify({ type: 'success', title: 'Archive Completed', message: task.label, taskId: id, trigger });
        } catch (err) {
            task.lastStatus = 'error';
            task.lastError = err.message;
            if (task.notifyOnError) this.notify({ type: 'error', title: 'Archive Failed', message: `${task.label}: ${err.message}`, taskId: id, trigger });
        } finally {
            task.lastRunAt = new Date().toISOString();
            task.nextRunAt = new Date(Date.now() + task.intervalMinutes * MINUTE_MS).toISOString();
            task.updatedAt = new Date().toISOString();
            this.running.delete(id);
            this.arm(task);
            await this.persist();
        }

        return task;
    }

    stop() {
        for (const id of this.timers.keys()) {
            this.disarm(id);
        }
    }
}
