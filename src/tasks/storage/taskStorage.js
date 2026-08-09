/**
 * Task Storage Abstraction
 *
 * Browser/Electron: uses localStorage
 * Tests/Node: uses in-memory Map fallback
 *
 * Never directly access localStorage without checking availability.
 */

const isBrowser = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

class TaskStorage {
    constructor() {
        this._memory = new Map();
        this._prefix = 'emerald_tasks_';
    }

    _key(key) {
        return this._prefix + key;
    }

    getItem(key) {
        if (isBrowser) {
            try {
                return window.localStorage.getItem(this._key(key));
            } catch {
                return this._memory.get(key) || null;
            }
        }
        return this._memory.get(key) || null;
    }

    setItem(key, value) {
        if (isBrowser) {
            try {
                window.localStorage.setItem(this._key(key), value);
                return;
            } catch {
                // fall through to memory
            }
        }
        this._memory.set(key, value);
    }

    removeItem(key) {
        if (isBrowser) {
            try {
                window.localStorage.removeItem(this._key(key));
            } catch {
                // fall through to memory
            }
        }
        this._memory.delete(key);
    }

    clear() {
        if (isBrowser) {
            try {
                const keys = [];
                for (let i = 0; i < window.localStorage.length; i++) {
                    const k = window.localStorage.key(i);
                    if (k && k.startsWith(this._prefix)) {
                        keys.push(k);
                    }
                }
                for (const k of keys) {
                    window.localStorage.removeItem(k);
                }
            } catch {
                // fall through to memory
            }
        }
        this._memory.clear();
    }
}

// Singleton
const taskStorage = new TaskStorage();
export default taskStorage;
