import { useEffect, useRef, useState, useCallback } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import '../css/bots.css';

const BOT_STATUS_CONFIG = {
    running: { label: 'ONLINE', className: 'botStatusRunning' },
    starting: { label: 'STARTING', className: 'botStatusStarting' },
    stopped: { label: 'OFFLINE', className: 'botStatusStopped' },
    error: { label: 'ERROR', className: 'botStatusError' }
};

export default function Bots({ route, setRoute }) {
    const [status, setStatus] = useState({ status: 'stopped', isRunning: false, error: null });
    const [logs, setLogs] = useState([]);
    const [totalLogs, setTotalLogs] = useState(0);
    const [botInfo, setBotInfo] = useState(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [showInstructions, setShowInstructions] = useState(false);
    const logRef = useRef(null);
    const logsEndRef = useRef(null);

    // Load initial data
    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            setLoading(true);
            setMessage('');

            try {
                const [statusResult, logsResult, infoResult] = await Promise.all([
                    invoke('bot:status'),
                    invoke('bot:logs', 100),
                    invoke('bot:info')
                ]);

                if (!cancelled) {
                    if (statusResult) setStatus(statusResult);
                    if (logsResult) {
                        setLogs(logsResult.logs || []);
                        setTotalLogs(logsResult.total || 0);
                    }
                    if (infoResult) setBotInfo(infoResult);
                }
            } catch (err) {
                if (!cancelled) {
                    setMessage(err?.message || 'Failed to load bot data');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadInitialData();

        // Listen for real-time log updates
        const unsubscribe = window.electronAPI?.on?.('bot-log', (logEntry) => {
            setLogs(prev => {
                const updated = [...prev, logEntry];
                return updated.slice(-500);
            });
            setTotalLogs(prev => prev + 1);
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    // Auto-scroll logs
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    // Poll status every 3 seconds
    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const result = await invoke('bot:status');
                if (result) setStatus(result);
            } catch {
                // ignore poll errors
            }
        }, 3000);

        return () => clearInterval(interval);
    }, []);

    const handleStart = async () => {
        setActionLoading(true);
        setMessage('');

        try {
            const result = await invoke('bot:start');
            if (result?.ok) {
                setMessage('Bot container started');
                setStatus(result);
            } else {
                setMessage(result?.error || 'Failed to start bot');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to start bot');
        } finally {
            setActionLoading(false);
        }
    };

    const handleStop = async () => {
        setActionLoading(true);
        setMessage('');

        try {
            const result = await invoke('bot:stop');
            if (result?.ok) {
                setMessage('Bot container stopped');
                setStatus(result);
            } else {
                setMessage(result?.error || 'Failed to stop bot');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to stop bot');
        } finally {
            setActionLoading(false);
        }
    };

    const handleRestart = async () => {
        setActionLoading(true);
        setMessage('');

        try {
            const result = await invoke('bot:restart');
            if (result?.ok) {
                setMessage('Bot container restarted');
                setStatus(result);
            } else {
                setMessage(result?.error || 'Failed to restart bot');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to restart bot');
        } finally {
            setActionLoading(false);
        }
    };

    const handleBuild = async () => {
        setActionLoading(true);
        setMessage('');

        try {
            const result = await invoke('bot:build');
            if (result?.ok) {
                setMessage('Docker image built successfully');
            } else {
                setMessage(result?.error || 'Failed to build image');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to build image');
        } finally {
            setActionLoading(false);
        }
    };

    const handleClearLogs = async () => {
        try {
            await invoke('bot:logs:clear');
            setLogs([]);
            setTotalLogs(0);
            setMessage('Logs cleared');
        } catch (err) {
            setMessage(err?.message || 'Failed to clear logs');
        }
    };

    const handleRefreshLogs = async () => {
        try {
            const result = await invoke('bot:logs', 200);
            if (result) {
                setLogs(result.logs || []);
                setTotalLogs(result.total || 0);
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to refresh logs');
        }
    };

    const statusConfig = BOT_STATUS_CONFIG[status.status] || BOT_STATUS_CONFIG.stopped;

    return (
        <PageShell title="Bots" route={route} setRoute={setRoute} leftChildren={
            <div className="botsSidebar">
                <button type="button" onClick={() => setRoute('dashboard')}>Back to Dashboard</button>
                <div className="botsSidebarInfo">
                    <h3>INFBOT</h3>
                    <p>Docker container</p>
                    <p className="botsSidebarStatus">
                        Status: <span className={`botsStatusDot ${statusConfig.className}`}></span>
                        {statusConfig.label}
                    </p>
                </div>
            </div>
        }>
            <div className="botsContent">
                {/* Status Bar */}
                <div className="botsStatusBar">
                    <div className="botsStatusIndicator">
                        <span className={`botsStatusDot ${statusConfig.className}`}></span>
                        <span className="botsStatusLabel">{statusConfig.label}</span>
                    </div>
                    <div className="botsStatusDetails">
                        {status.error && <span className="botsStatusError">{status.error}</span>}
                        {status.dockerStatus && <span className="botsStatusCount">{status.dockerStatus}</span>}
                        <span className="botsStatusCount">{totalLogs} log entries</span>
                    </div>
                </div>

                {/* Control Panel */}
                <div className="botsPanel">
                    <div className="botsPanelHeader">
                        <h3>Bot Control</h3>
                    </div>
                    <div className="botsPanelContent">
                        <div className="botsControls">
                            <button
                                type="button"
                                className="botButton botButtonStart"
                                onClick={handleStart}
                                disabled={actionLoading || status.isRunning}
                            >
                                START
                            </button>
                            <button
                                type="button"
                                className="botButton botButtonStop"
                                onClick={handleStop}
                                disabled={actionLoading || !status.isRunning}
                            >
                                STOP
                            </button>
                            <button
                                type="button"
                                className="botButton botButtonRestart"
                                onClick={handleRestart}
                                disabled={actionLoading}
                            >
                                RESTART
                            </button>
                            <button
                                type="button"
                                className="botButton botButtonBuild"
                                onClick={handleBuild}
                                disabled={actionLoading}
                            >
                                BUILD IMAGE
                            </button>
                        </div>

                        {message && (
                            <div className={`botsMessage ${message.includes('Failed') || message.includes('Error') ? 'botsMessageError' : 'botsMessageSuccess'}`}>
                                {message}
                            </div>
                        )}

                        {loading && <div className="botsLoading">Loading bot data...</div>}
                    </div>
                </div>

                {/* Docker Instructions Panel */}
                {botInfo && (
                    <div className="botsPanel">
                        <div className="botsPanelHeader">
                            <h3>Docker Management</h3>
                            <button
                                type="button"
                                className="botsToggleInstructions"
                                onClick={() => setShowInstructions(!showInstructions)}
                            >
                                {showInstructions ? 'Hide' : 'Show'} CLI Commands
                            </button>
                        </div>
                        {showInstructions && (
                            <div className="botsPanelContent">
                                <div className="botsInstructions">
                                    <p className="botsInstructionsNote">
                                        The bot runs in a Docker container with <code>--restart unless-stopped</code>,
                                        so it survives app and PC restarts. Use these commands for manual management:
                                    </p>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Build image:</span>
                                        <code>{botInfo.instructions.buildCommand}</code>
                                    </div>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Run container:</span>
                                        <code>{botInfo.instructions.runCommand}</code>
                                    </div>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Stop:</span>
                                        <code>{botInfo.instructions.stopCommand}</code>
                                    </div>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Start:</span>
                                        <code>{botInfo.instructions.startCommand}</code>
                                    </div>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Logs:</span>
                                        <code>{botInfo.instructions.logsCommand}</code>
                                    </div>
                                    <div className="botsCommandBlock">
                                        <span className="botsCommandLabel">Remove:</span>
                                        <code>{botInfo.instructions.removeCommand}</code>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Bot Info Panel */}
                {botInfo && (
                    <div className="botsPanel">
                        <div className="botsPanelHeader">
                            <h3>Bot Information</h3>
                        </div>
                        <div className="botsPanelContent">
                            <div className="botsInfoGrid">
                                <div className="botsInfoItem">
                                    <span className="botsInfoLabel">Name</span>
                                    <span className="botsInfoValue">{botInfo.name}</span>
                                </div>
                                <div className="botsInfoItem">
                                    <span className="botsInfoLabel">Version</span>
                                    <span className="botsInfoValue">{botInfo.version}</span>
                                </div>
                                <div className="botsInfoItem">
                                    <span className="botsInfoLabel">Runtime</span>
                                    <span className="botsInfoValue">{botInfo.runtime}</span>
                                </div>
                                <div className="botsInfoItem botsInfoItemFull">
                                    <span className="botsInfoLabel">Description</span>
                                    <span className="botsInfoValue">{botInfo.description}</span>
                                </div>
                            </div>

                            <div className="botsSection">
                                <h4>Commands</h4>
                                <div className="botsCommandsList">
                                    {botInfo.commands.map((cmd, i) => (
                                        <div key={i} className="botsCommandItem">
                                            <span className="botsCommandName">{cmd.name}</span>
                                            <span className="botsCommandDesc">{cmd.description}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="botsSection">
                                <h4>Features</h4>
                                <div className="botsFeaturesList">
                                    {botInfo.features.map((feature, i) => (
                                        <span key={i} className="botsFeatureTag">{feature}</span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Logs Panel */}
                <div className="botsPanel botsLogPanel">
                    <div className="botsPanelHeader">
                        <h3>Bot Logs</h3>
                        <div className="botsPanelActions">
                            <button type="button" onClick={handleRefreshLogs} disabled={loading}>
                                Refresh
                            </button>
                            <button type="button" onClick={handleClearLogs} disabled={loading || logs.length === 0}>
                                Clear
                            </button>
                        </div>
                    </div>
                    <div className="botsPanelScroll botsLogContainer" ref={logRef}>
                        {logs.length === 0 ? (
                            <div className="botsLogPlaceholder">
                                No logs yet. Start the bot container to see output.
                            </div>
                        ) : (
                            logs.map((log, index) => (
                                <div key={log.id || index} className={`botsLogLine botsLogLine--${log.type}`}>
                                    <span className="botsLogTime">{new Date(log.timestamp).toLocaleTimeString()}</span>
                                    <span className="botsLogType">{log.type}</span>
                                    <span className="botsLogMessage">{log.message}</span>
                                </div>
                            ))
                        )}
                        <div ref={logsEndRef} />
                    </div>
                </div>
            </div>
        </PageShell>
    );
}
