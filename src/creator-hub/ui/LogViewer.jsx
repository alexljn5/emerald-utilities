// src/creator-hub/ui/LogViewer.jsx
// Log viewer for Creator Hub.
// Displays developer logs with filtering by level.

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';

function formatTime(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function getLevelClass(level) {
    switch (level) {
        case 'debug': return 'chLogDebug';
        case 'info': return 'chLogInfo';
        case 'warn': return 'chLogWarn';
        case 'error': return 'chLogError';
        default: return '';
    }
}

export default function LogViewer() {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all'); // 'all' | 'debug' | 'info' | 'warn' | 'error'
    const [logLevel, setLogLevel] = useState('info');

    useEffect(() => {
        loadLogs();
        loadLogLevel();
    }, []);

    useEffect(() => {
        const interval = setInterval(loadLogs, 2000);
        return () => clearInterval(interval);
    }, []);

    async function loadLogs() {
        const result = await invoke('creator-hub:get-log-history');
        if (result.ok) {
            setLogs(result.history || []);
        }
        setLoading(false);
    }

    async function loadLogLevel() {
        const result = await invoke('creator-hub:get-log-level');
        if (result.ok) {
            setLogLevel(result.level);
        }
    }

    async function handleSetLevel(level) {
        await invoke('creator-hub:set-log-level', { level });
        setLogLevel(level);
    }

    async function handleClear() {
        await invoke('creator-hub:clear-log-history');
        setLogs([]);
    }

    const filteredLogs = filter === 'all'
        ? logs
        : logs.filter(log => log.level === filter);

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Developer Logs</div>

            {/* Log level selector */}
            <div className="chButtonGroup chFilterButtonGroup">
                {['debug', 'info', 'warn', 'error'].map(level => (
                    <button
                        key={level}
                        type="button"
                        className={`chButton ${logLevel === level ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleSetLevel(level)}
                    >
                        {level.toUpperCase()}
                    </button>
                ))}
                <button
                    type="button"
                    className="chButton chButtonDanger"
                    onClick={handleClear}
                >
                    Clear
                </button>
            </div>

            {/* Filter */}
            <div className="chButtonGroup chFilterButtonGroup">
                {['all', 'debug', 'info', 'warn', 'error'].map(f => (
                    <button
                        key={f}
                        type="button"
                        className={`chButton ${filter === f ? 'chButtonPrimary' : ''}`}
                        onClick={() => setFilter(f)}
                    >
                        {f === 'all' ? 'All' : f.toUpperCase()}
                    </button>
                ))}
            </div>

            {/* Log list */}
            {loading ? (
                <div className="chEmpty">Loading logs...</div>
            ) : filteredLogs.length === 0 ? (
                <div className="chEmpty">No logs to display.</div>
            ) : (
                <div className="chLogList">
                    {filteredLogs.map((log, index) => (
                        <div key={index} className={`chLogEntry chLogEntry--${log.level}`}>
                            <span className="chLogTime">{formatTime(log.timestamp)}</span>
                            <span className={`chLogLevel ${getLevelClass(log.level)}`}>
                                {log.level.toUpperCase()}
                            </span>
                            <span className="chLogMessage">{log.message}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
