// src/creator-hub/ui/AccountPanel.jsx
// Dynamic platform-specific account detail panel.
// Renders account info based on platform metadata.

import { ACCOUNT_STATUS } from '../../globals.js';

function formatDate(dateStr) {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function getStatusClass(status) {
    switch (status) {
        case ACCOUNT_STATUS.CONNECTED: return 'chStatusSuccess';
        case ACCOUNT_STATUS.ERROR: return 'chStatusError';
        case ACCOUNT_STATUS.PENDING: return 'chStatusPending';
        default: return 'chStatusPending';
    }
}

export default function AccountPanel({ account, platformMeta, onTest, onDisconnect, onRemove, testingId }) {
    if (!account || !platformMeta) return null;

    const caps = account.capabilities || {};
    const meta = account.metadata || {};

    return (
        <div className="chAccountPanel">
            <div className="chAccountPanelHeader">
                <strong className="chAccountPanelTitle">
                    {platformMeta.name} Account
                </strong>
                <button
                    type="button"
                    className="chButton chButtonSmall chAccountPanelClose"
                    onClick={onRemove}
                    aria-label="Close"
                >
                    ×
                </button>
            </div>

            <div className="chAccountPanelInfo">
                <span className="chAccountPanelLabel">Username</span>
                <span>@{account.username}</span>
                <span className="chAccountPanelLabel">Status</span>
                <span className={`chStatus ${getStatusClass(account.status)}`}>
                    {account.status}
                </span>
                <span className="chAccountPanelLabel">Last used</span>
                <span>{formatDate(account.lastUsed)}</span>
            </div>

            {/* Authentication info */}
            <div className="chAccountPanelSection">
                <div className="chAccountPanelSectionTitle">
                    Authentication:
                </div>
                <div className="chAccountPanelContent">
                    {platformMeta.requirements.authentication === 'oauth' && 'OAuth 2.0'}
                    {platformMeta.requirements.authentication === 'app_password' && 'App Password'}
                    {platformMeta.requirements.authentication === 'access_token' && 'Access Token'}
                    {platformMeta.requirements.authentication === 'api_key' && 'API Key'}
                </div>
            </div>

            {/* Capabilities */}
            <div className="chAccountPanelSection">
                <div className="chAccountPanelSectionTitle">
                    Capabilities:
                </div>
                <div>
                    {caps.text && <span className="chCapBadge">Text</span>}
                    {caps.images && <span className="chCapBadge">Images</span>}
                    {caps.video && <span className="chCapBadge">Video</span>}
                    {caps.maxChars > 0 && (
                        <span className="chCapBadge chCapBadge--limit">
                            {caps.maxChars} chars
                        </span>
                    )}
                </div>
            </div>

            {/* Publish stats */}
            {(meta.totalPublished > 0 || meta.totalFailed > 0) && (
                <div className="chAccountPanelSection">
                    <div className="chAccountPanelSectionTitle">
                        Publishing History:
                    </div>
                    <div className="chAccountPanelContent">
                        {meta.totalPublished} published, {meta.totalFailed} failed
                    </div>
                    {meta.lastSuccessfulPublish && (
                        <div className="chAccountPanelMeta">
                            Last success: {formatDate(meta.lastSuccessfulPublish)}
                        </div>
                    )}
                </div>
            )}

            <div className="chButtonGroup">
                <button
                    type="button"
                    className="chButton"
                    onClick={onTest}
                    disabled={testingId === account.id}
                >
                    {testingId === account.id ? 'Testing...' : 'Test Connection'}
                </button>
                {account.status === ACCOUNT_STATUS.CONNECTED && (
                    <button
                        type="button"
                        className="chButton"
                        onClick={onDisconnect}
                    >
                        Disconnect
                    </button>
                )}
                <button
                    type="button"
                    className="chButton chButtonDanger"
                    onClick={onRemove}
                >
                    Remove
                </button>
            </div>
        </div>
    );
}
