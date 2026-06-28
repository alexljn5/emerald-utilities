import { useEffect, useRef, useState } from 'react';

export const TERMINAL_KEY = 'emerald_terminal_log';
export const MAX_TERMINAL_LINES = 500;

export function normalizeLogEntry(entry) {
    if (typeof entry === 'string') {
        return { id: null, message: entry };
    }

    return {
        id: entry?.id ?? null,
        message: entry?.message ?? ''
    };
}

export function useTerminalLog() {
    const [terminalLog, setTerminalLog] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem(TERMINAL_KEY) || '[]').map(normalizeLogEntry);
        } catch {
            return [];
        }
    });

    const appendTerminalLog = (entry) => {
        const normalized = normalizeLogEntry(entry);
        if (!normalized.message) return;

        setTerminalLog((current) => {
            if (normalized.id !== null && current.some((item) => item.id === normalized.id)) {
                return current;
            }

            return [...current, normalized].slice(-MAX_TERMINAL_LINES);
        });
    };

    useEffect(() => {
        const saveTimer = setTimeout(() => {
            localStorage.setItem(TERMINAL_KEY, JSON.stringify(terminalLog.slice(-MAX_TERMINAL_LINES)));
        }, 200);

        return () => clearTimeout(saveTimer);
    }, [terminalLog]);

    const terminalRef = useRef(null);

    useEffect(() => {
        if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [terminalLog]);

    return { terminalLog, appendTerminalLog, terminalRef };
}
