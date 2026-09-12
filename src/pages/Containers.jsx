import { useEffect, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import '../css/containers.css';

const TABS = {
    CONTAINERS: 'containers',
    BOTS: 'bots'
};

export default function Containers({ route, setRoute }) {
    const [activeTab, setActiveTab] = useState(TABS.CONTAINERS);
    const [activeContainers, setActiveContainers] = useState([]);
    const [allContainers, setAllContainers] = useState([]);
    const [loadingContainers, setLoadingContainers] = useState(false);
    const [containerError, setContainerError] = useState(null);
    const [sshTest, setSshTest] = useState(null);
    const [testingSsh, setTestingSsh] = useState(false);

    // Load containers on mount
    useEffect(() => {
        let cancelled = false;

        async function loadContainers() {
            setLoadingContainers(true);
            setContainerError(null);
            try {
                const [activeResult, allResult] = await Promise.all([
                    invoke('container:list-active'),
                    invoke('container:list-all')
                ]);

                if (!cancelled) {
                    if (activeResult?.ok) {
                        setActiveContainers(activeResult.containers || []);
                        if (activeResult.errors?.length > 0) {
                            setContainerError(activeResult.error);
                        }
                    } else {
                        setContainerError(activeResult?.error || 'Failed to load active containers');
                    }
                    if (allResult?.ok) {
                        setAllContainers(allResult.containers || []);
                    }
                }
            } catch (err) {
                if (!cancelled) {
                    setContainerError(err.message || 'Failed to load containers');
                }
            } finally {
                if (!cancelled) setLoadingContainers(false);
            }
        }

        loadContainers();

        // Refresh container list every 10 seconds
        const containerInterval = setInterval(() => {
            loadContainers();
        }, 10000);

        return () => clearInterval(containerInterval);
    }, []);

    async function handleTestSsh() {
        setTestingSsh(true);
        setSshTest(null);
        try {
            const result = await invoke('container:test-ssh');
            setSshTest(result);
        } catch (err) {
            setSshTest({ ok: false, error: err.message });
        } finally {
            setTestingSsh(false);
        }
    }

    return (
        <PageShell title="Containers" route={route} setRoute={setRoute}>
            <div className="botsContent">
                {/* Tab Bar */}
                <div className="botsTabBar">
                    <button
                        className={`botsTab ${activeTab === TABS.CONTAINERS ? 'botsTab--active' : ''}`}
                        onClick={() => setActiveTab(TABS.CONTAINERS)}
                    >
                        Containers
                    </button>
                    <button
                        className={`botsTab ${activeTab === TABS.BOTS ? 'botsTab--active' : 'botsTab--disabled'}`}
                        onClick={() => setActiveTab(TABS.BOTS)}
                        disabled={activeTab === TABS.BOTS}
                        title="Bot management — coming later"
                    >
                        Bots <span className="botsTabBadge">(LATER)</span>
                    </button>
                </div>

                {/* Tab Content */}
                {activeTab === TABS.CONTAINERS && (
                    <div className="botsTabContent">
                        {/* SSH Diagnostics */}
                        <div className="containerBridgeSection">
                            <div className="containerCardHeader">
                                <h2 style={{ margin: 0 }}>SSH Connection</h2>
                                <button
                                    className="botsTab"
                                    onClick={handleTestSsh}
                                    disabled={testingSsh}
                                    style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                                >
                                    {testingSsh ? 'Testing...' : 'Test SSH'}
                                </button>
                            </div>
                            {sshTest && (
                                <p className="placeholder" style={{ color: sshTest.ok ? '#44ff66' : '#ff6b6b', margin: 0 }}>
                                    {sshTest.ok
                                        ? `✓ Connected to ${sshTest.host} via Tailscale`
                                        : `✗ ${sshTest.host}: ${sshTest.error || sshTest.stderr || 'Connection failed'}`}
                                </p>
                            )}
                            {containerError && !sshTest && (
                                <p className="placeholder" style={{ color: '#ff6b6b', margin: 0 }}>
                                    ⚠ {containerError}
                                </p>
                            )}
                        </div>

                        {/* Active Containers Bridge */}
                        <div className="containerBridgeSection">
                            <h2>Active Containers</h2>
                            {loadingContainers ? (
                                <p className="placeholder">Scanning for active containers...</p>
                            ) : activeContainers.length === 0 ? (
                                <p className="placeholder">No active containers found. Start a bot or container to see it here.</p>
                            ) : (
                                <div className="containerList">
                                    {activeContainers.map((container, idx) => (
                                        <div key={container.id || idx} className="containerCard">
                                            <div className="containerCardHeader">
                                                <span className="containerName">{container.name || container.id}</span>
                                                <span className={`containerStatus ${container.status === 'running' ? 'statusRunning' : 'statusStopped'}`}>
                                                    {container.status === 'running' ? 'RUNNING' : container.status || 'UNKNOWN'}
                                                </span>
                                            </div>
                                            <div className="containerDetails">
                                                <span>Host: {container.host || 'remote'}</span>
                                                <span>Image: {container.image || 'N/A'}</span>
                                                {container.ports && <span>Ports: {container.ports}</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* All Containers (including stopped) */}
                        <div className="containerBridgeSection">
                            <h2>All Containers ({allContainers.length})</h2>
                            {allContainers.length === 0 ? (
                                <p className="placeholder">No containers discovered.</p>
                            ) : (
                                <div className="containerList">
                                    {allContainers.map((container, idx) => (
                                        <div key={container.id || idx} className="containerCard">
                                            <div className="containerCardHeader">
                                                <span className="containerName">{container.name || container.id}</span>
                                                <span className={`containerStatus ${container.status === 'running' ? 'statusRunning' : 'statusStopped'}`}>
                                                    {container.status === 'running' ? 'RUNNING' : container.status || 'STOPPED'}
                                                </span>
                                            </div>
                                            <div className="containerDetails">
                                                <span>Host: {container.host || 'remote'}</span>
                                                <span>Image: {container.image || 'N/A'}</span>
                                                {container.ports && <span>Ports: {container.ports}</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === TABS.BOTS && (
                    <div className="botsPlaceholder">
                        <h2>Bot Management</h2>
                        <p>Coming later — bot management will be available in a future update.</p>
                    </div>
                )}
            </div>
        </PageShell>
    );
}
