// src/creator-hub/ui/CreatorHubPage.jsx
// Main Creator Hub page — Dashboard with account cards, Composer, Queue, History, Logs, Accounts.

import { useState, useEffect } from 'react';
import PageShell from '../../pages/PageShell.jsx';
import Sidebar from './Sidebar.jsx';
import Composer from './Composer.jsx';
import Queue from './Queue.jsx';
import History from './History.jsx';
import PostLogs from './PostLogs.jsx';
import Accounts from './Accounts.jsx';
import { ACCOUNT_STATUS, CREATOR_HUB } from '../../globals.js';
import { invoke } from '../../utils/electronApi.js';
import { getPlatform } from '../../creator-hub/services/platforms.js';

export default function CreatorHubPage({ route, setRoute }) {
    const [selectedPost, setSelectedPost] = useState(null);
    const [selectedLog, setSelectedLog] = useState(null);
    const [selectedAccount, setSelectedAccount] = useState(null);
    const [view, setView] = useState('dashboard'); // 'dashboard' | 'accounts' | 'composer' | 'queue' | 'history' | 'logs'
    const [accounts, setAccounts] = useState([]);

    function handlePostCreated(post) {
        setSelectedPost(post);
        setView('queue');
    }

    function handleSelectPost(post) {
        setSelectedPost(post);
        setView('composer');
    }

    function handleCancelEdit() {
        setSelectedPost(null);
    }

    function handleAccountAdded(account) {
        setAccounts(prev => [...prev, account]);
    }

    function handleSelectLog(log) {
        setSelectedLog(log);
        setView('logs');
    }

    function handleBackToLogs() {
        setSelectedLog(null);
    }

    function handleSelectAccountForCompose(account) {
        setSelectedAccount(account);
        setView('composer');
    }

    function handleBackToDashboard() {
        setSelectedAccount(null);
        setView('dashboard');
    }

    async function loadAccounts() {
        const result = await invoke('creator-hub:list-accounts');
        if (result.ok) {
            setAccounts(result.accounts);
        }
    }

    // Load accounts on mount
    useEffect(() => {
        loadAccounts();
    }, []);

    if (!CREATOR_HUB.ENABLED) {
        return (
            <PageShell title="Creator Hub" route={route} setRoute={setRoute}>
                <div className="chPanel">
                    <div className="chPanelHeader">Creator Hub</div>
                    <div className="chEmpty">Creator Hub is disabled in settings.</div>
                </div>
            </PageShell>
        );
    }

    return (
        <PageShell
            title="Creator Hub"
            route={route}
            setRoute={setRoute}
            leftChildren={
                <Sidebar
                    onSelectPost={handleSelectPost}
                    selectedPostId={selectedPost?.id}
                    currentView={view}
                    onViewChange={setView}
                    onSelectLog={handleSelectLog}
                />
            }
        >
            <div className="creatorHub">
                <div className="creatorHubRight">
                    {view === 'dashboard' && (
                        <Dashboard
                            accounts={accounts}
                            onSelectAccount={handleSelectAccountForCompose}
                            onRefresh={loadAccounts}
                        />
                    )}
                    {view === 'accounts' && (
                        <Accounts
                            onAccountAdded={handleAccountAdded}
                            onSelectAccountForCompose={handleSelectAccountForCompose}
                        />
                    )}
                    {view === 'composer' && (
                        <Composer
                            selectedAccount={selectedAccount}
                            editingPost={selectedPost}
                            onPostCreated={handlePostCreated}
                            onCancelEdit={handleCancelEdit}
                            onBack={selectedAccount ? handleBackToDashboard : null}
                        />
                    )}
                    {view === 'queue' && <Queue />}
                    {view === 'history' && (
                        <History
                            postId={selectedPost?.id}
                            accountId={null}
                        />
                    )}
                    {view === 'logs' && <PostLogs log={selectedLog} onBack={handleBackToLogs} />}
                </div>
            </div>
        </PageShell>
    );
}

// ==================== DASHBOARD ====================

function Dashboard({ accounts, onSelectAccount, onRefresh }) {
    const connectedAccounts = accounts.filter(a => a.status === ACCOUNT_STATUS.CONNECTED);

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Connected Accounts</div>
            {connectedAccounts.length === 0 ? (
                <div className="chEmpty">
                    No accounts connected. Use the Accounts page to add your first account.
                </div>
            ) : (
                <div className="chDashboardGrid">
                    {connectedAccounts.map(account => {
                        const platformMeta = getPlatform(account.platform);
                        const capabilities = platformMeta?.capabilities || {};
                        return (
                            <div
                                key={account.id}
                                className="chAccountCard"
                                onClick={() => onSelectAccount(account)}
                            >
                                <div className="chAccountCardHeader">
                                    <span className="chAccountCardPlatform">
                                        {account.platform}
                                    </span>
                                    <span className="chStatus chStatusConnected">Connected</span>
                                </div>
                                <div className="chAccountCardBody">
                                    <div className="chAccountCardUsername">@{account.username}</div>
                                    <div className="chAccountCardDisplayName">{account.displayName || account.username}</div>
                                </div>
                                <div className="chAccountCardCapabilities">
                                    {capabilities.text && <span className="chCapBadge">Text</span>}
                                    {capabilities.images && <span className="chCapBadge">Images</span>}
                                    {capabilities.video && <span className="chCapBadge">Video</span>}
                                    {capabilities.maxChars > 0 && <span className="chCapBadge chCapBadge--limit">{capabilities.maxChars} chars</span>}
                                </div>
                                <div className="chAccountCardAction">
                                    <button
                                        type="button"
                                        className="chButton chButtonPrimary"
                                        onClick={(e) => { e.stopPropagation(); onSelectAccount(account); }}
                                    >
                                        Create Post
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
