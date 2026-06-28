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

    useEffect(() => {
        loadStats();
        loadNetworkFiles();
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

    return (
        <PageShell title="Database" route={route} setRoute={setRoute}>
            <div className="databasePage">
                <section className="dbSection">
                    <h2>Connection Status</h2>
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
                            <div className="statCard">
                                <span className="statLabel">Connected</span>
                                <span className="statValue">{stats.connected ? 'Yes' : 'No'}</span>
                            </div>
                        </div>
                    ) : (
                        <p>No stats available. Is the database running?</p>
                    )}
                </section>

                <section className="dbSection">
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

                {importLog.length > 0 && (
                    <section className="dbSection">
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
