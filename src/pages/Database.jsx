import { useEffect, useState } from 'react';
import PageShell from './PageShell.jsx';
import '../css/globals.css';
import { invoke } from '../utils/electronApi.js';

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

    useEffect(() => {
        loadStats();
        loadNetworkFiles();
        loadConnectionInfo();
        loadTables();
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
            const result = await invoke('database:query', { sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;" });
            if (result && result.rows) {
                setTables(result.rows.map(r => r.table_name));
            }
        } catch (err) {
            console.error('Failed to load tables:', err);
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
        setImportLog(prev => [...prev, 'Select Grok export JSON file...']);
        try {
            const result = await invoke('database:import-grok-export');
            setImportLog(prev => [...prev, `Imported ${result.importedMessages} messages from ${result.importedConversations} conversations`]);
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
                <section className="dbBox">
                    <h2>Connection</h2>
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
                                <span className="connLabel">User</span>
                                <span className="connValue">{connectionInfo.user}</span>
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

                <section className="dbBox">
                    <h2>Statistics</h2>
                    {loading ? (
                        <p>Loading...</p>
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
                        <p>No stats available. Is the database running?</p>
                    )}
                </section>

                <section className="dbBox">
                    <h2>Import Data</h2>
                    <div className="importControls">
                        <div className="importRow">
                            <label htmlFor="networkFileSelect">Network JSONL:</label>
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
                        <div className="importRow">
                            <button
                                type="button"
                                onClick={importGrokExport}
                                disabled={importing}
                            >
                                {importing ? 'Importing...' : 'Import Grok Export (JSON)'}
                            </button>
                        </div>
                        <div className="importRow">
                            <button
                                type="button"
                                onClick={importBlacklist}
                                disabled={importing}
                            >
                                {importing ? 'Importing...' : 'Import Blacklisted IPs'}
                            </button>
                        </div>
                    </div>
                </section>

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
                                <p>Loading...</p>
                            ) : queryError ? (
                                <div className="queryError">{queryError}</div>
                            ) : queryResult ? (
                                <div className="queryResult">
                                    <h4>{selectedTable} ({queryResult.rows?.length ?? 0} rows)</h4>
                                    {queryResult.rows && queryResult.rows.length > 0 ? (
                                        <div className="tableWrapper">
                                            <table className="resultTable">
                                                <thead>
                                                    <tr>
                                                        {Object.keys(queryResult.rows[0]).map(key => (
                                                            <th key={key}>{key}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {queryResult.rows.map((row, i) => (
                                                        <tr key={i}>
                                                            {Object.values(row).map((val, j) => (
                                                                <td key={j}>{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}</td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <p>No rows.</p>
                                    )}
                                </div>
                            ) : (
                                <p className="placeholder">Select a table to browse</p>
                            )}
                        </div>
                    </div>
                </section>

                <section className="dbBox">
                    <h2>SQL Query</h2>
                    <div className="queryBox">
                        <textarea
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="SELECT * FROM network_packet_events LIMIT 10;"
                            rows={4}
                            className="queryInput"
                        />
                        <button
                            type="button"
                            onClick={runQuery}
                            disabled={querying || !query.trim()}
                            className="actionBtn"
                            style={{ marginTop: '8px' }}
                        >
                            {querying ? 'Running...' : 'Run Query'}
                        </button>
                    </div>
                    {queryError && queryResult === null && (
                        <div className="queryError">
                            <strong>Error:</strong> {queryError}
                        </div>
                    )}
                    {queryResult && selectedTable === '' && (
                        <div className="queryResult">
                            <h4>Result ({queryResult.rows?.length ?? 0} rows)</h4>
                            {queryResult.rows && queryResult.rows.length > 0 ? (
                                <div className="tableWrapper">
                                    <table className="resultTable">
                                        <thead>
                                            <tr>
                                                {Object.keys(queryResult.rows[0]).map(key => (
                                                    <th key={key}>{key}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {queryResult.rows.map((row, i) => (
                                                <tr key={i}>
                                                    {Object.values(row).map((val, j) => (
                                                        <td key={j}>{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <p>No rows returned.</p>
                            )}
                        </div>
                    )}
                </section>

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
