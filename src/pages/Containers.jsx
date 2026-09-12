import { useEffect, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import '../css/containers.css';

const TABS = {
    CONTAINERS: 'containers',
    BOTS: 'bots'
};

const SSH_SETUP = {
    Windows: {
        label: 'Windows (PowerShell)',
        keyPath: '$env:USERPROFILE\\.ssh\\id_ed25519',
        steps: [
            'Open PowerShell in your project directory',
            'Generate an Ed25519 key with no passphrase:',
            'ssh-keygen -t ed25519 -C "alexljn5@infhub" -f $env:USERPROFILE\\.ssh\\id_ed25519 -N ""',
            'Add the public key to the server:',
            'cat $env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh -o StrictHostKeyChecking=no alexljn5@infhub-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"',
            'Verify the connection:',
            'ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i $env:USERPROFILE\\.ssh\\id_ed25519 alexljn5@infhub-server "echo ok"'
        ]
    },
    Linux: {
        label: 'Linux (Bash)',
        keyPath: '~/.ssh/id_ed25519',
        steps: [
            'Open a terminal in your project directory',
            'Generate an Ed25519 key with no passphrase:',
            'ssh-keygen -t ed25519 -C "alexljn5@infhub" -f ~/.ssh/id_ed25519 -N ""',
            'Add the public key to the server:',
            'cat ~/.ssh/id_ed25519.pub | ssh -o StrictHostKeyChecking=no alexljn5@infhub-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"',
            'Verify the connection:',
            'ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i ~/.ssh/id_ed25519 alexljn5@infhub-server "echo ok"'
        ]
    },
    Mac: {
        label: 'macOS (Bash)',
        keyPath: '~/.ssh/id_ed25519',
        steps: [
            'Open Terminal in your project directory',
            'Generate an Ed25519 key with no passphrase:',
            'ssh-keygen -t ed25519 -C "alexljn5@infhub" -f ~/.ssh/id_ed25519 -N ""',
            'Add the public key to the server:',
            'cat ~/.ssh/id_ed25519.pub | ssh -o StrictHostKeyChecking=no alexljn5@infhub-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"',
            'Verify the connection:',
            'ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i ~/.ssh/id_ed25519 alexljn5@infhub-server "echo ok"'
        ]
    }
};

export default function Containers({ route, setRoute }) {
    const [activeTab, setActiveTab] = useState(TABS.CONTAINERS);
    const [activeContainers, setActiveContainers] = useState([]);
    const [allContainers, setAllContainers] = useState([]);
    const [loadingContainers, setLoadingContainers] = useState(false);
    const [containerError, setContainerError] = useState(null);
    const [sshTest, setSshTest] = useState(null);
    const [testingSsh, setTestingSsh] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [infoPlatform, setInfoPlatform] = useState('Windows');

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
                                <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
                                    <button
                                        className="infoBtn"
                                        onClick={() => setShowInfo(true)}
                                        title="SSH setup instructions"
                                        aria-label="SSH setup instructions"
                                    >
                                        ?
                                    </button>
                                    <button
                                        className="botsTab"
                                        onClick={handleTestSsh}
                                        disabled={testingSsh}
                                        style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                                    >
                                        {testingSsh ? 'Testing...' : 'Test SSH'}
                                    </button>
                                </div>
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

                {/* SSH Setup Info Modal */}
                {showInfo && (
                    <div className="infoModal" onClick={() => setShowInfo(false)}>
                        <div className="infoModalContent" onClick={(e) => e.stopPropagation()}>
                            <button
                                className="infoModalClose"
                                onClick={() => setShowInfo(false)}
                                aria-label="Close"
                            >
                                ✕
                            </button>
                            <h2>SSH Setup — Plug &amp; Play</h2>
                            <p>The Containers page needs SSH access to <code>infhub-server</code> (Tailscale MagicDNS) to list Docker containers. Follow these steps once per machine.</p>

                            <h3>1. Pick your platform</h3>
                            <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap', marginBottom: 'var(--space-sm)' }}>
                                {Object.keys(SSH_SETUP).map((platform) => (
                                    <button
                                        key={platform}
                                        className={`botsTab ${infoPlatform === platform ? 'botsTab--active' : ''}`}
                                        onClick={() => setInfoPlatform(platform)}
                                        style={{ padding: '4px 12px', fontSize: '0.75rem' }}
                                    >
                                        {platform}
                                    </button>
                                ))}
                            </div>

                            <h3>2. Generate an SSH key</h3>
                            <p>Run this in your terminal (no passphrase — required for automated connections):</p>
                            <code>{SSH_SETUP[infoPlatform].steps[2]}</code>

                            <h3>3. Add the public key to the server</h3>
                            <p>Copy your public key to the server's authorized_keys:</p>
                            <code>{SSH_SETUP[infoPlatform].steps[3]}</code>
                            <p style={{ color: '#ffaa00', fontSize: '0.75rem' }}>
                                ⚠ You'll be prompted for your server password once. After this, key-based auth works automatically.
                            </p>

                            <h3>4. Verify the connection</h3>
                            <code>{SSH_SETUP[infoPlatform].steps[4]}</code>
                            <p style={{ color: '#44ff66' }}>If it prints <code>ok</code>, you're connected.</p>

                            <h3>5. Configure the app</h3>
                            <p>Edit <code>src/containers/bot-config.json</code> to point at your key:</p>
                            <code>{`{
  "sshHost": "infhub-server",
  "sshUser": "alexljn5",
  "sshPort": "22",
  "sshKey": "${SSH_SETUP[infoPlatform].keyPath}",
  "autoStart": true
}`}</code>

                            <h3>Per-machine note</h3>
                            <p>This setup must be done on <strong>every machine</strong> you connect from. The SSH key is machine-specific — generate a new key on each machine and add the public key to the server. The server accumulates keys, so you can add multiple machine keys over time.</p>
                        </div>
                    </div>
                )}
            </div>
        </PageShell>
    );
}
