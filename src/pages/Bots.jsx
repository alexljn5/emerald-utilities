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
    const [botMode, setBotMode] = useState('script');
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [showInstructions, setShowInstructions] = useState(false);
    const [autoStart, setAutoStart] = useState(true);
    const [availableScripts, setAvailableScripts] = useState([]);
    const [terminalInput, setTerminalInput] = useState('');
    const [terminalHistory, setTerminalHistory] = useState([]);
    const logContainerRef = useRef(null);
    const terminalInputRef = useRef(null);

    // Load initial data
    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            setLoading(true);
            setMessage('');

            try {
                const [statusResult, logsResult, infoResult, modeResult, autoStartResult, scriptsResult] = await Promise.all([
                    invoke('bot:status'),
                    invoke('bot:logs', 100),
                    invoke('bot:info'),
                    invoke('bot:mode'),
                    invoke('bot:getAutoStart'),
                    invoke('bot:detectScripts')
                ]);

                if (!cancelled) {
                    if (statusResult) setStatus(statusResult);
                    if (logsResult) {
                        setLogs(logsResult.logs || []);
                        setTotalLogs(logsResult.total || 0);
                    }
                    if (infoResult) setBotInfo(infoResult);
                    if (modeResult?.mode) setBotMode(modeResult.mode);
                    if (autoStartResult?.enabled !== undefined) {
                        setAutoStart(autoStartResult.enabled);
                    }
                    if (scriptsResult?.ok) {
                        setAvailableScripts(scriptsResult.scripts || []);
                    }
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

    // Save auto-start preference
    useEffect(() => {
        invoke('bot:setAutoStart', autoStart).catch(() => {
            // ignore save errors
        });
    }, [autoStart]);

    // Auto-scroll logs within the log container only (not the whole page)
    useEffect(() => {
        if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
    }, [logs]);

    // Auto-scroll terminal
    useEffect(() => {
        if (terminalInputRef.current) {
            terminalInputRef.current.scrollTop = terminalInputRef.current.scrollHeight;
        }
    }, [terminalHistory]);

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
                setMessage('Bot started');
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
                setMessage('Bot stopped');
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
                setMessage('Bot restarted');
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

    const handleModeChange = async (newMode) => {
        setActionLoading(true);
        setMessage('');
        try {
            const result = await invoke('bot:setMode', newMode);
            if (result?.ok) {
                setBotMode(newMode);
                setMessage(result.message || `Mode switched to ${newMode}. Restart app to apply.`);
            } else {
                setMessage(result?.error || 'Failed to change mode');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to change mode');
        } finally {
            setActionLoading(false);
        }
    };

    const handleAutoStartToggle = async () => {
        const newValue = !autoStart;
        setActionLoading(true);
        setMessage('');
        try {
            const result = await invoke('bot:setAutoStart', newValue);
            if (result?.ok) {
                setAutoStart(newValue);
                setMessage(newValue ? 'Auto-start enabled' : 'Auto-start disabled');
            } else {
                setMessage(result?.error || 'Failed to update auto-start');
            }
        } catch (err) {
            setMessage(err?.message || 'Failed to update auto-start');
        } finally {
            setActionLoading(false);
        }
    };

    const handleTerminalCommand = async (e) => {
        e.preventDefault();
        const cmd = terminalInput.trim();
        if (!cmd) return;

        setTerminalInput('');
        setTerminalHistory(prev => [...prev, { type: 'input', text: cmd }]);

        try {
            const result = await invoke('bot:sendCommand', cmd);
            if (result?.ok) {
                setTerminalHistory(prev => [...prev, { type: 'output', text: `> ${cmd}` }]);
            } else {
                setTerminalHistory(prev => [...prev, { type: 'error', text: `Error: ${result?.error || 'Failed to send command'}` }]);
            }
        } catch (err) {
            setTerminalHistory(prev => [...prev, { type: 'error', text: `Error: ${err?.message || 'Failed to send command'}` }]);
        }
    };

    const runtimeLabel = botMode === 'docker' ? 'Docker Container' : botMode === 'screen' ? 'GNU Screen Session' : 'Node.js Process';
    const modeLabel = botMode === 'docker' ? 'Docker' : botMode === 'screen' ? 'Screen' : 'Script';

    return (
        <PageShell title="Bots" route={route} setRoute={setRoute} leftChildren={
            <div className="botsSidebar">
                <button type="button" onClick={() => setRoute('dashboard')}>Back to Dashboard</button>
                <div className="botsSidebarInfo">
                    <h3>INFBOT</h3>
                    <p>{runtimeLabel}</p>
                    <p className="botsSidebarStatus">
                        Status: <span className={`botsStatusDot ${statusConfig.className}`}></span>
                        {statusConfig.label}
                    </p>
                    <p className="botsSidebarMode">
                        Mode: {modeLabel}
                    </p>
                    <div className="botsAutoStartRow">
                        <label className="botsToggleLabel">
                            <input
                                type="checkbox"
                                checked={autoStart}
                                onChange={handleAutoStartToggle}
                            />
                            Auto-start on launch
                        </label>
                    </div>
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
                        <select
                            value={botMode}
                            onChange={(e) => handleModeChange(e.target.value)}
                            className="botsModeSelect"
                            disabled={actionLoading}
                        >
                            <option value="script">Script (Abstract)</option>
                            <option value="screen">Screen (Homelab)</option>
                            <option value="docker">Docker (Local)</option>
                        </select>
                        {status.error && <span className="botsStatusError">{status.error}</span>}
                        {botMode === 'docker' && status.dockerStatus && (
                            <span className="botsStatusCount">{status.dockerStatus}</span>
                        )}
                        {botMode === 'screen' && status.screenSession && (
                            <span className="botsStatusCount">Session: {status.screenSession}</span>
                        )}
                        {botMode === 'script' && status.scriptPid && (
                            <span className="botsStatusCount">PID: {status.scriptPid}</span>
                        )}
                        <span className="botsStatusCount">{totalLogs} log entries</span>
                    </div>
                </div>

                {/* Control Panel */}
                <div className="botsPanel">
                    <div className="botsPanelHeader">
                        <h3>Bot Control</h3>
                        <span className="botsModeBadge">{modeLabel}</span>
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
                            {botMode === 'docker' && (
                                <button
                                    type="button"
                                    className="botButton botButtonBuild"
                                    onClick={handleBuild}
                                    disabled={actionLoading}
                                >
                                    BUILD IMAGE
                                </button>
                            )}
                        </div>
                        <div className="botsAutoStartRow">
                            <label className="botsToggleLabel">
                                <input
                                    type="checkbox"
                                    checked={autoStart}
                                    onChange={handleAutoStartToggle}
                                />
                                Auto-start bot on app launch
                            </label>
                            <span className="botsAutoStartHint">
                                {autoStart ? 'Bot will start automatically when the app opens' : 'Bot will not start automatically'}
                            </span>
                        </div>

                        {message && (
                            <div className={`botsMessage ${message.includes('Failed') || message.includes('Error') ? 'botsMessageError' : 'botsMessageSuccess'}`}>
                                {message}
                            </div>
                        )}

                        {loading && <div className="botsLoading">Loading bot data...</div>}
                    </div>
                </div>

                {/* Management Instructions Panel */}
                {botInfo && (
                    <div className="botsPanel">
                        <div className="botsPanelHeader">
                            <h3>{modeLabel} Management</h3>
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
                                        {botMode === 'docker'
                                            ? 'The bot runs in a Docker container with --restart unless-stopped, so it survives app and PC restarts. Use these commands for manual management:'
                                            : botMode === 'screen'
                                                ? `The bot runs in a GNU Screen session (${botInfo.instructions.session}) on the homelab server. It survives restarts via screen. Use these commands for manual management:`
                                                : 'The bot runs as a detached Node.js process. It survives app restarts. Use these commands for manual management:'}
                                    </p>
                                    {botMode === 'docker' ? (
                                        <>
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
                                        </>
                                    ) : botMode === 'screen' ? (
                                        <>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Start:</span>
                                                <code>{botInfo.instructions.startCommand}</code>
                                            </div>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Stop:</span>
                                                <code>{botInfo.instructions.stopCommand}</code>
                                            </div>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Attach:</span>
                                                <code>{botInfo.instructions.attachCommand}</code>
                                            </div>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Logs:</span>
                                                <code>{botInfo.instructions.logsCommand}</code>
                                            </div>
                                        </>
                                    ) : (
                                        <>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Start:</span>
                                                <code>{botInfo.instructions.startCommand}</code>
                                            </div>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Stop:</span>
                                                <code>{botInfo.instructions.stopCommand}</code>
                                            </div>
                                            <div className="botsCommandBlock">
                                                <span className="botsCommandLabel">Logs:</span>
                                                <code>{botInfo.instructions.logsCommand}</code>
                                            </div>
                                            {availableScripts.length > 0 && (
                                                <div className="botsCommandBlock">
                                                    <span className="botsCommandLabel">Available scripts:</span>
                                                    <code>{availableScripts.join(', ')}</code>
                                                </div>
                                            )}
                                        </>
                                    )}
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
                    <div className="botsPanelScroll botsLogContainer" ref={logContainerRef}>
                        {logs.length === 0 ? (
                            <div className="botsLogPlaceholder">
                                No logs yet. Start the bot to see output.
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
                    </div>
                </div>

                {/* Terminal Panel */}
                <div className="botsPanel botsTerminalPanel">
                    <div className="botsPanelHeader">
                        <h3>Terminal</h3>
                        <span className="botsModeBadge">{modeLabel}</span>
                    </div>
                    <div className="botsTerminalOutput" ref={terminalInputRef}>
                        {terminalHistory.length === 0 ? (
                            <div className="botsTerminalPlaceholder">
                                Type commands below to interact with the bot. Available in {modeLabel} mode.
                            </div>
                        ) : (
                            terminalHistory.map((entry, index) => (
                                <div key={index} className={`botsTerminalLine botsTerminalLine--${entry.type}`}>
                                    <span className="botsTerminalPrompt">{entry.type === 'input' ? '$' : '>'}</span>
                                    <span className="botsTerminalText">{entry.text}</span>
                                </div>
                            ))
                        )}
                    </div>
                    <form className="botsTerminalInputRow" onSubmit={handleTerminalCommand}>
                        <span className="botsTerminalPrompt">$</span>
                        <input
                            type="text"
                            value={terminalInput}
                            onChange={(e) => setTerminalInput(e.target.value)}
                            placeholder="Enter command..."
                            className="botsTerminalInput"
                            disabled={actionLoading || !status.isRunning}
                        />
                        <button
                            type="submit"
                            className="botButton botButtonStart"
                            disabled={actionLoading || !status.isRunning || !terminalInput.trim()}
                        >
                            SEND
                        </button>
                    </form>
                </div>
            </div>
        </PageShell>
    );
}
