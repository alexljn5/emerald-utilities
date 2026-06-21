// src/core/networkManager.js

function parseTcpdumpLine(line) {
    const timestamp = new Date().toISOString();
    const parsed = {
        raw: line,
        parsedAt: timestamp,
        type: 'packet',
        protocol: 'unparsed'
    };

    const tcpdumpMatch = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(IP6?|ARP|ICMP|TCP|UDP)\s+(.+)$/i);
    if (!tcpdumpMatch) return parsed;

    const [, date, time, iface, direction, protocol, payload] = tcpdumpMatch;
    const transport = payload.match(/\b(TCP|UDP|ICMP)\b/i)?.[1]?.toUpperCase();
    const lengthMatch = payload.match(/length\s+(\d+)/i);
    const length = lengthMatch ? Number(lengthMatch[1]) : null;

    const splitHostPort = (value) => {
        const cleaned = String(value || '').replace(/:$/, '');
        const lastDot = cleaned.lastIndexOf('.');

        if (lastDot > -1 && /^\d+$/.test(cleaned.slice(lastDot + 1))) {
            return {
                host: cleaned.slice(0, lastDot),
                port: Number(cleaned.slice(lastDot + 1))
            };
        }

        return { host: cleaned, port: null };
    };

    const [srcRaw = '', dstRaw = ''] = payload.split(/\s+>\s+/);
    const source = splitHostPort(srcRaw);
    const destination = splitHostPort(dstRaw);

    return {
        ...parsed,
        timestamp: `${date} ${time}`,
        interface: iface,
        direction,
        protocol: protocol.toUpperCase(),
        transport,
        source,
        destination,
        length,
        summary: `${source.host}${source.port ? `:${source.port}` : ''} -> ${destination.host}${destination.port ? `:${destination.port}` : ''}${transport ? ` ${transport}` : ''}${length ? ` ${length} bytes` : ''}`
    };
}

function toBinaryPreview(value) {
    const text = String(value || '');
    const bits = Array.from(text, (char) => char.charCodeAt(0).toString(2).padStart(8, '0')).join('');
    return bits.slice(0, 160) + (bits.length > 160 ? '…' : '');
}

export class NetworkManager {
    constructor() {
        this.state = {
            isCapturing: false,
            logs: [],
            parserLogs: [],
            latestPacket: null,
            binaryPreview: '',
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

    async startCapture(options = {}) {
        const result = await this.invoke('network-start-capture', options);

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

    async syncCaptureStatus() {
        try {
            const result = await this.invoke('network-capture:get-status');
            if (result?.ok) {
                this.state.isCapturing = Boolean(result.isCapturing);
                this.state.status = result.status || (result.isCapturing ? 'Capturing...' : 'Idle');
                this.emit();
            }
        } catch {
            // Non-fatal: the dashboard still works even if the status IPC call fails.
        }
    }

    addLog(line) {
        const packet = parseTcpdumpLine(String(line || ''));
        const parserEntry = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            raw: line,
            packet,
            binary: toBinaryPreview(JSON.stringify(packet))
        };

        this.state.logs.push(line);
        if (this.state.logs.length > 2000) this.state.logs.shift();

        this.state.parserLogs.push(parserEntry);
        if (this.state.parserLogs.length > 80) this.state.parserLogs.shift();

        this.state.latestPacket = parserEntry;
        this.state.binaryPreview = parserEntry.binary;
        this.emit();
    }

    clearLogs() {
        this.state.logs = [];
        this.state.parserLogs = [];
        this.state.latestPacket = null;
        this.state.binaryPreview = '';
        this.emit();
    }
}

export const networkManager = new NetworkManager();
