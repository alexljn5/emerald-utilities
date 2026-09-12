import { useEffect, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import { formatDateTime } from '../utils/dateUtils.js';
import '../css/containers.css';

const BOT_STATUS_CONFIG = {
    running: { label: 'ONLINE', className: 'botStatusRunning' },
    starting: { label: 'STARTING', className: 'botStatusStarting' },
    stopped: { label: 'OFFLINE', className: 'botStatusStopped' },
    error: { label: 'ERROR', className: 'botStatusError' }
};

const TABS = {
    CONTAINERS: 'containers',
    BOTS: 'bots'
};

export default function Containers({ route, setRoute }) {
    const [bots, setBots] = useState([]);
    const [selectedBotId, setSelectedBotId] = useState('infbot');
    const [status, setStatus] = useState({ status: 'stopped', isRunning: false, error: null });
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState(TABS.CONTAINERS);
    const [activeContainers, setActiveContainers] = useState([]);
    const [allContainers, setAllContainers] = useState([]);
    const [loadingContainers, setLoadingContainers] = useState(false);
    const [containerError, setContainerError] = useState(null);

    const selectedBot = bots.find(b => b.id === selectedBotId) || bots[0];

    // Load initial data
    useEffect(() => {
        let cancelled = false;

        async function loadInitialData() {
            setLoading(true);
            try {
                const [listResult, statusResult] = await Promise.all([
                    invoke('bot:list'),
                    invoke('bot:status', selectedBotId)
                ]);

                if (!cancelled) {
                    if (listResult?.ok) {
                        setBots(listResult.bots || []);
                        if (listResult.bots?.length > 0 && !listResult.bots.find(b => b.id === selectedBotId)) {
                            setSelectedBotId(listResult.bots[0].id);
                        }
                    }
                    if (statusResult) setStatus(statusResult);
                }
            } catch {
                // ignore
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadInitialData();

        // Poll status every 3 seconds for selected bot
        const interval = setInterval(async () => {
            try {
                const result = await invoke('bot:status', selectedBotId);
                if (result) setStatus(result);
            } catch {
                // ignore poll errors
            }
        }, 3000);

        return () => clearInterval(interval);
    }, [selectedBotId]);

    // Load active containers on mount
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

    const statusConfig = BOT_STATUS_CONFIG[status.status] || BOT_STATUS_CONFIG.stopped;

    return (
        <PageShell title="Containers" route={route} setRoute={setRoute} leftChildren={
            <div className="botsSidebar">
                {/* Bot List */}
                <div className="botsSidebarSection">
                    <h4>Bots ({bots.length})</h4>
                    <div className="botsList">
                        {bots.map(bot => (
                            <div
                                key={bot.id}
                                className={`botsListItem ${bot.id === selectedBotId ? 'botsListItem--active' : ''}`}
                                onClick={() => setSelectedBotId(bot.id)}
                            >
                                <span className={`botsStatusDot ${BOT_STATUS_CONFIG[bot.status]?.className || 'botStatusStopped'}`}></span>
                                <span className="botsListItemName">{bot.name}</span>
                                <span className="botsListItemHost">{bot.host}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Selected Bot Info */}
                {selectedBot && (
                    <div className="botsSidebarInfo">
                        <h3>{selectedBot.name}</h3>
                        <p>{selectedBot.type} on {selectedBot.host}</p>
                        <p className="botsSidebarStatus">
                            Status: <span className={`botsStatusDot ${statusConfig.className}`}></span>
                            {statusConfig.label}
                        </p>
                        {status.error && (
                            <p className="botsSidebarError">{status.error}</p>
                        )}
                    </div>
                )}
            </div>
        }>
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
                        {/* Active Containers Bridge */}
                        <div className="containerBridgeSection">
                            <h2>Active Containers</h2>
                            {loadingContainers ? (
                                <p className="placeholder">Scanning for active containers...</p>
                            ) : containerError ? (
                                <p className="placeholder" style={{ color: '#ff6b6b' }}>Error: {containerError}</p>
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
                        <p className="botsPlaceholderHint">Use the sidebar to view registered bots and their status.</p>
                    </div>
                )}
            </div>
        </PageShell>
    );
}
