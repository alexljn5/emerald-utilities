import { useEffect, useState } from 'react';
import PageShell from './PageShell.jsx';
import '../css/database.css';   // Make sure this file is imported
import { invoke, on } from '../utils/electronApi.js';

const defaultScheduleForm = {
    id: '',
    label: 'Daily archive backup',
    action: 'backup',
    intervalMinutes: 1440,
    enabled: true,
    notifyOnStart: true,
    notifyOnSuccess: true,
    notifyOnError: true,
    runMissedOnBoot: true
};

export default function Database({ route, setRoute }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [importing, setImporting] = useState(false);
    const [importLog, setImportLog] = useState([]);
    const [networkFiles, setNetworkFiles] = useState([]);
    const [selectedFile, setSelectedFile] = useState('');
    const [query, setQuery] = useState('SELECT * FROM network_packet_events LIMIT 10;');
    const [queryResult, setQueryResult] = useState(null);
    const [queryError, setQueryError] = useState('');
    const [querying, setQuerying] = useState(false);
    const [connectionInfo, setConnectionInfo] = useState(null);
    const [tables, setTables] = useState([]);
    const [selectedTable, setSelectedTable] = useState('');
    const [tableData, setTableData] = useState(null);
    const [loadingTable, setLoadingTable] = useState(false);
    const [backups, setBackups] = useState([]);
    const [backupStatus, setBackupStatus] = useState('');
    const [restoring, setRestoring] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [selectedBackup, setSelectedBackup] = useState('');
    const [scheduleForm, setScheduleForm] = useState(defaultScheduleForm);
    const [scheduledTasks, setScheduledTasks] = useState([]);
    const [scheduleStatus, setScheduleStatus] = useState('');
    const [toasts, setToasts] = useState([]);

    useEffect(() => {
        loadStats();
        loadNetworkFiles();
        loadConnectionInfo();
        loadTables();
        loadBackups();
        loadScheduledTasks();
    }, []);

    useEffect(() => {
        return on('archive-notification', (toast) => {
            const id = toast.id || `toast-${Date.now()}`;
            setToasts(prev => [...prev, { ...toast, id }].slice(-4));
            window.setTimeout(() => {
                setToasts(prev => prev.filter(item => item.id !== id));
            }, 5200);
        });
    }, []);

    async function loadStats() {
        try {
            const result = await invoke('database:get-stats');
            setStats(result);
        } catch (err) {
            console.error('Failed to load database stats:', err);
        } finally {
            setLoading(false);
        }
    }

    async function loadNetworkFiles() {
        try {
            const result = await invoke('network-logs:list', { folder: 'ALL' });
            setNetworkFiles(result.files || []);
        } catch (err) {
            console.error('Failed to load network files:', err);
        }
    }

    async function loadConnectionInfo() {
        try {
            const result = await invoke('database:get-connection-info');
            setConnectionInfo(result);
        } catch (err) {
            console.error('Failed to load connection info:', err);
        }
    }

    async function loadTables() {
        try {
            const result = await invoke('database:query', {
                sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
            });
            if (result && result.rows) {
                setTables(result.rows.map(r => r.table_name));
            }
        } catch (err) {
            console.error('Failed to load tables:', err);
        }
    }

    async function loadBackups() {
        try {
            const result = await invoke('database:list-backups');
            if (result.ok) {
                setBackups(result.backups || []);
            }
        } catch (err) {
            console.error('Failed to load backups:', err);
        }
    }

    async function loadScheduledTasks() {
        try {
            const result = await invoke('archive-scheduler:list');
            if (result.ok) {
                setScheduledTasks(result.tasks || []);
            }
        } catch (err) {
            setScheduleStatus(`Schedule load failed: ${err.message}`);
        }
    }

    function updateScheduleField(field, value) {
        setScheduleForm(prev => ({ ...prev, [field]: value }));
    }

    async function saveSchedule(event) {
        event.preventDefault();
        setScheduleStatus('Saving schedule...');
        try {
            const result = await invoke('archive-scheduler:save', scheduleForm);
            if (!result.ok) throw new Error(result.error);
            setScheduledTasks(result.tasks || []);
            setScheduleForm(defaultScheduleForm);
            setScheduleStatus('Schedule saved');
        } catch (err) {
            setScheduleStatus(`Schedule save failed: ${err.message}`);
        }
    }

    async function runScheduledTask(id) {
        const result = await invoke('archive-scheduler:run-now', { id });
        if (result.ok) {
            setScheduledTasks(result.tasks || scheduledTasks);
            setScheduleStatus('Task queued');
        } else {
            setScheduleStatus(`Task failed to queue: ${result.error}`);
        }
    }

    async function deleteScheduledTask(id) {
        const result = await invoke('archive-scheduler:delete', { id });
        if (result.ok) {
            setScheduledTasks(result.tasks || []);
        } else {
            setScheduleStatus(`Delete failed: ${result.error}`);
        }
    }

    async function triggerDebugNotification() {
        await invoke('archive-notification:debug');
    }

    async function runBackup() {
        setBackupStatus('Creating backup...');
        try {
            const result = await invoke('database:backup');
            if (result.ok) {
                setBackupStatus('Backup created successfully!');
                await loadBackups();
            } else {
                setBackupStatus(`Backup failed: ${result.error}`);
            }
        } catch (err) {
            setBackupStatus(`Backup error: ${err.message}`);
        }
    }

    async function runRestore() {
        if (!selectedBackup) return;
        setRestoring(true);
        setBackupStatus('Restoring...');
        try {
            const result = await invoke('database:restore', selectedBackup);
            if (result.ok) {
                setBackupStatus('Restore completed successfully!');
            } else {
                setBackupStatus(`Restore failed: ${result.error}`);
            }
        } catch (err) {
            setBackupStatus(`Restore error: ${err.message}`);
        } finally {
            setRestoring(false);
        }
    }

    async function runVerify() {
        if (!selectedBackup) return;
        setVerifying(true);
        setBackupStatus('Verifying...');
        try {
            const result = await invoke('database:verify', selectedBackup);
            if (result.ok) {
                setBackupStatus('Verification completed!');
            } else {
                setBackupStatus(`Verification failed: ${result.error}`);
            }
        } catch (err) {
            setBackupStatus(`Verify error: ${err.message}`);
        } finally {
            setVerifying(false);
        }
    }

    async function importNetworkLog() {
        if (!selectedFile) return;
        setImporting(true);
        setImportLog(prev => [...prev, `Importing ${selectedFile}...`]);
        try {
            const result = await invoke('database:import-network-log', { file: selectedFile });
            setImportLog(prev => [...prev, `Imported ${result.imported} packets (${result.failed} failed)`]);
            await loadStats();
        } catch (err) {
            setImportLog(prev => [...prev, `Error: ${err.message}`]);
        } finally {
            setImporting(false);
            setSelectedFile('');
        }
    }

    async function importGrokExport() {
        setImporting(true);
        setImportLog(prev => [...prev, 'Importing Grok export...']);
        try {
            const result = await invoke('database:import-grok-export');
            setImportLog(prev => [...prev, `Imported ${result.importedMessages} messages from ${result.importedConversations} conversations${result.failed > 0 ? ` (${result.failed} failed)` : ''}`]);
            await loadStats();
        } catch (err) {
            setImportLog(prev => [...prev, `Error: ${err.message}`]);
        } finally {
            setImporting(false);
        }
    }

    async function importBlacklist() {
        setImporting(true);
        setImportLog(prev => [...prev, 'Importing blacklisted IPs...']);
        try {
            const result = await invoke('database:import-blacklist');
            setImportLog(prev => [...prev, `Imported ${result.count} threat indicators`]);
            await loadStats();
        } catch (err) {
            setImportLog(prev => [...prev, `Error: ${err.message}`]);
        } finally {
            setImporting(false);
        }
    }

    async function runQuery() {
        if (!query.trim()) return;
        setQuerying(true);
        setQueryError('');
        setQueryResult(null);
        try {
            const result = await invoke('database:query', { sql: query.trim() });
            setQueryResult(result);
        } catch (err) {
            setQueryError(err.message);
        } finally {
            setQuerying(false);
        }
    }

    async function browseTable(tableName) {
        setSelectedTable(tableName);
        setLoadingTable(true);
        setQueryError('');
        setQueryResult(null);
        try {
            const result = await invoke('database:query', { sql: `SELECT * FROM ${tableName} LIMIT 50;` });
            setQueryResult(result);
        } catch (err) {
            setQueryError(err.message);
        } finally {
            setLoadingTable(false);
        }
    }

    return (
        <PageShell title="Database" route={route} setRoute={setRoute}>
            <div className="databasePage">
                <div className="archiveToastRegion" aria-live="polite" aria-atomic="false">
                    {toasts.map(toast => (
                        <div key={toast.id} className={`archiveToast archiveToast--${toast.type || 'info'}`}>
                            <strong>{toast.title}</strong>
                            <span>{toast.message}</span>
                        </div>
                    ))}
                </div>

                {/* Archive Scheduling */}
                <section className="dbBox">
                    <h2>Archive Scheduling</h2>
                    <form className="archiveScheduleForm" onSubmit={saveSchedule}>
                        <div className="scheduleGrid">
                            <label>
                                Name
                                <input
                                    className="dbInput"
                                    value={scheduleForm.label}
                                    onChange={(e) => updateScheduleField('label', e.target.value)}
                                />
                            </label>
                            <label>
                                Action
                                <select
                                    className="dbInput"
                                    value={scheduleForm.action}
                                    onChange={(e) => updateScheduleField('action', e.target.value)}
                                >
                                    <option value="backup">Create backup</option>
                                    <option value="verify">Verify backups</option>
                                    <option value="metadata-sync">Sync metadata</option>
                                </select>
                            </label>
                            <label>
                                Interval minutes
                                <input
                                    className="dbInput"
                                    type="number"
                                    min="1"
                                    value={scheduleForm.intervalMinutes}
                                    onChange={(e) => updateScheduleField('intervalMinutes', e.target.value)}
                                />
                            </label>
                        </div>
                        <div className="scheduleOptions">
                            <label><input type="checkbox" checked={scheduleForm.enabled} onChange={(e) => updateScheduleField('enabled', e.target.checked)} /> Enabled</label>
                            <label><input type="checkbox" checked={scheduleForm.notifyOnStart} onChange={(e) => updateScheduleField('notifyOnStart', e.target.checked)} /> Notify start</label>
                            <label><input type="checkbox" checked={scheduleForm.notifyOnSuccess} onChange={(e) => updateScheduleField('notifyOnSuccess', e.target.checked)} /> Notify success</label>
                            <label><input type="checkbox" checked={scheduleForm.notifyOnError} onChange={(e) => updateScheduleField('notifyOnError', e.target.checked)} /> Notify error</label>
                            <label><input type="checkbox" checked={scheduleForm.runMissedOnBoot} onChange={(e) => updateScheduleField('runMissedOnBoot', e.target.checked)} /> Run missed on boot</label>
                        </div>
                        <div className="scheduleActions">
                            <button type="submit">Save Schedule</button>
                            <button type="button" onClick={triggerDebugNotification}>[DEBUG: TRIGGER TEST NOTIFICATION]</button>
                        </div>
                    </form>
                    {scheduleStatus && <div className="backupStatus">{scheduleStatus}</div>}
                    <div className="scheduleList">
                        {scheduledTasks.length === 0 ? (
                            <p className="placeholder">No archive schedules configured</p>
                        ) : scheduledTasks.map(task => (
                            <div className="scheduleItem" key={task.id}>
                                <div>
                                    <strong>{task.label}</strong>
                                    <span>{task.action} every {task.intervalMinutes} minutes</span>
                                    <span>Next: {new Date(task.nextRunAt).toLocaleString()}</span>
                                    <span>Status: {task.lastStatus}</span>
                                </div>
                                <div className="scheduleItemActions">
                                    <button type="button" onClick={() => runScheduledTask(task.id)}>Run Now</button>
                                    <button type="button" onClick={() => deleteScheduledTask(task.id)}>Delete</button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Connection */}
                <section className="dbBox">
                    <h2>Connection Status</h2>
                    {connectionInfo ? (
                        <div className="connectionBox">
                            <div className="connRow">
                                <span className="connLabel">Host</span>
                                <span className="connValue">{connectionInfo.host}</span>
                            </div>
                            <div className="connRow">
                                <span className="connLabel">Port</span>
                                <span className="connValue">{connectionInfo.port}</span>
                            </div>
                            <div className="connRow">
                                <span className="connLabel">Database</span>
                                <span className="connValue">{connectionInfo.database}</span>
                            </div>
                            <div className="connRow">
                                <span className="connLabel">Status</span>
                                <span className={`connValue ${connectionInfo.connected ? 'statusConnected' : 'statusDisconnected'}`}>
                                    {connectionInfo.connected ? 'Connected' : 'Disconnected'}
                                </span>
                            </div>
                        </div>
                    ) : (
                        <p>Loading connection info...</p>
                    )}
                </section>

                {/* Statistics */}
                <section className="dbBox">
                    <h2>Statistics</h2>
                    {loading ? (
                        <p>Loading stats...</p>
                    ) : stats ? (
                        <div className="dbStats">
                            <div className="statCard">
                                <span className="statLabel">Total Packets</span>
                                <span className="statValue">{stats.totalPackets ?? 0}</span>
                            </div>
                            <div className="statCard">
                                <span className="statLabel">Grok Messages</span>
                                <span className="statValue">{stats.grokMessages ?? 0}</span>
                            </div>
                            <div className="statCard">
                                <span className="statLabel">Grok Conversations</span>
                                <span className="statValue">{stats.grokConversations ?? 0}</span>
                            </div>
                            <div className="statCard">
                                <span className="statLabel">Active Threats</span>
                                <span className="statValue">{stats.activeThreats ?? 0}</span>
                            </div>
                            <div className="statCard">
                                <span className="statLabel">Blacklisted Packets</span>
                                <span className="statValue">{stats.blacklistedPackets ?? 0}</span>
                            </div>
                        </div>
                    ) : (
                        <p>No stats available.</p>
                    )}
                </section>

                {/* Import Tools */}
                <section className="dbBox">
                    <h2>Import Tools</h2>
                    <div className="importControls">
                        <div className="importRow">
                            <label htmlFor="networkFileSelect">Network Log:</label>
                            <select
                                id="networkFileSelect"
                                value={selectedFile}
                                onChange={(e) => setSelectedFile(e.target.value)}
                                disabled={importing}
                            >
                                <option value="">-- Select a file --</option>
                                {networkFiles.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={importNetworkLog}
                                disabled={importing || !selectedFile}
                            >
                                {importing ? 'Importing...' : 'Import'}
                            </button>
                        </div>

                        <button
                            type="button"
                            onClick={importGrokExport}
                            disabled={importing}
                        >
                            {importing ? 'Importing...' : 'Import Grok Export (JSON)'}
                        </button>

                        <button
                            type="button"
                            onClick={importBlacklist}
                            disabled={importing}
                        >
                            {importing ? 'Importing...' : 'Import Blacklisted IPs'}
                        </button>
                    </div>
                </section>

                {/* Volume Backup */}
                <section className="dbBox">
                    <h2>Volume Backup</h2>
                    <div className="backupControls">
                        <button
                            type="button"
                            onClick={runBackup}
                            disabled={importing}
                        >
                            Create Backup
                        </button>
                        <div className="restoreRow">
                            <label htmlFor="backupSelect">Restore from:</label>
                            <select
                                id="backupSelect"
                                value={selectedBackup}
                                onChange={(e) => setSelectedBackup(e.target.value)}
                                disabled={restoring}
                            >
                                <option value="">-- Select a backup --</option>
                                {backups.map(f => (
                                    <option key={f} value={f}>{f}</option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={runRestore}
                                disabled={restoring || !selectedBackup}
                            >
                                {restoring ? 'Restoring...' : 'Restore'}
                            </button>
                            <button
                                type="button"
                                onClick={runVerify}
                                disabled={verifying || !selectedBackup}
                            >
                                {verifying ? 'Verifying...' : 'Verify'}
                            </button>
                        </div>
                        {backupStatus && <div className="backupStatus">{backupStatus}</div>}
                    </div>
                </section>

                {/* Database Browser */}
                <section className="dbBox">
                    <h2>Database Browser</h2>
                    <div className="dbBrowser">
                        <div className="tableList">
                            <h4>Tables</h4>
                            {tables.length === 0 ? (
                                <p className="noTables">No tables found</p>
                            ) : (
                                <ul>
                                    {tables.map(t => (
                                        <li key={t}>
                                            <button
                                                type="button"
                                                className={`tableBtn ${selectedTable === t ? 'active' : ''}`}
                                                onClick={() => browseTable(t)}
                                            >
                                                {t}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        <div className="tableViewer">
                            {loadingTable ? (
                                <p>Loading table...</p>
                            ) : queryError ? (
                                <div className="queryError">{queryError}</div>
                            ) : queryResult ? (
                                <div className="queryResult">
                                    <h4>{selectedTable} ({queryResult.rows?.length ?? 0} rows)</h4>
                                    {/* Table rendering here */}
                                </div>
                            ) : (
                                <p className="placeholder">Select a table to browse</p>
                            )}
                        </div>
                    </div>
                </section>

                {/* SQL Query */}
                <section className="dbBox">
                    <h2>SQL Query</h2>
                    <div className="queryBox">
                        <textarea
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="SELECT * FROM network_packet_events LIMIT 10;"
                            rows={5}
                            className="queryInput"
                        />
                        <button
                            type="button"
                            onClick={runQuery}
                            disabled={querying || !query.trim()}
                        >
                            {querying ? 'Running...' : 'Run Query'}
                        </button>
                    </div>
                    {queryError && <div className="queryError">{queryError}</div>}
                    {queryResult && (
                        <div className="queryResult">
                            {/* Render result table */}
                        </div>
                    )}
                </section>

                {/* Import Log */}
                {importLog.length > 0 && (
                    <section className="dbBox">
                        <h2>Import Log</h2>
                        <div className="importLog">
                            {importLog.map((entry, i) => (
                                <div key={i} className="logEntry">{entry}</div>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => setImportLog([])}
                            className="clearLogBtn"
                        >
                            Clear Log
                        </button>
                    </section>
                )}
            </div>
        </PageShell>
    );
}
