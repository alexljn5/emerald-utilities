// src/core/networkManager.js
export class NetworkManager {
    constructor() {
        this.state = {
            isCapturing: false,
            logs: [],
            status: 'Idle'
        };

        this.listeners = new Set();
        this.boundEvents = false;

        if (typeof window !== 'undefined') {
            window.networkManager = this;
            this.bindEvents();
        }
    }

    get electronAPI() {
        return typeof window !== 'undefined' ? window.electronAPI : null;
    }

    onStateChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    emit() {
        for (const callback of this.listeners) {
            callback(this.state);
        }
    }

    bindEvents() {
        if (this.boundEvents || !this.electronAPI?.on) return;

        this.boundEvents = true;
        this.electronAPI.on('network-log', (line) => {
            this.addLog(line);
        });
    }

    async invoke(channel, ...args) {
        if (!this.electronAPI) throw new Error('Electron API not available');
        return this.electronAPI.invoke(channel, ...args);
    }

    async startCapture() {
        const result = await this.invoke('network-start-capture');

        if (result?.ok) {
            this.state.isCapturing = true;
            this.state.status = result.alreadyRunning ? 'Capturing...' : 'Capturing...';
            this.emit();
        }

        return result?.ok ?? false;
    }

    async stopCapture() {
        const result = await this.invoke('network-stop-capture');

        if (result?.ok) {
            this.state.isCapturing = false;
            this.state.status = 'Stopped';
            this.emit();
        }
    }

    addLog(line) {
        this.state.logs.push(line);
        if (this.state.logs.length > 2000) this.state.logs.shift();
        this.emit();
    }

    clearLogs() {
        this.state.logs = [];
        this.emit();
    }
}

export const networkManager = new NetworkManager();