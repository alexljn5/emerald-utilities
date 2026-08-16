import { useEffect, useState } from 'react';
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
    const [bots, setBots] = useState([]);
    const [selectedBotId, setSelectedBotId] = useState('infbot');
    const [status, setStatus] = useState({ status: 'stopped', isRunning: false, error: null });
    const [loading, setLoading] = useState(true);

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

    const statusConfig = BOT_STATUS_CONFIG[status.status] || BOT_STATUS_CONFIG.stopped;

    return (
        <PageShell title="Bots" route={route} setRoute={setRoute} leftChildren={
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
            <div className="botsContent botsContent--placeholder">
                <div className="botsPlaceholder">
                    <h2>Docker CI/CD</h2>
                    <p>Loading later here.</p>
                </div>
            </div>
        </PageShell>
    );
}
