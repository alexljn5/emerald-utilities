// src/creator-hub/ui/History.jsx
// Publishing history view for Creator Hub.
// Displays all publish attempts with status, timestamps, and errors.

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';

function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatDuration(ms) {
    if (!ms && ms !== 0) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function getStatusClass(status) {
    switch (status) {
        case 'success': return 'chStatusSuccess';
        case 'failed': return 'chStatusError';
        case 'skipped': return 'chStatusPending';
        default: return 'chStatusPending';
    }
}

export default function History({ postId, accountId, onRetry }) {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [retryingId, setRetryingId] = useState(null);
    const [filter, setFilter] = useState('all'); // 'all' | 'success' | 'failed' | 'skipped'

    useEffect(() => {
        loadHistory();
    }, [postId, accountId]);

    async function loadHistory() {
        setLoading(true);
        try {
            let result;
            if (postId) {
                result = await invoke('creator-hub:get-publish-history', { postId });
            } else if (accountId) {
                result = await invoke('creator-hub:get-publish-history', { accountId });
            } else {
                result = await invoke('creator-hub:list-publish-history');
            }
            if (result.ok) {
                setHistory(result.history || []);
            }
        } catch {
            // Ignore load errors
        } finally {
            setLoading(false);
        }
    }

    async function handleRetry(entryId) {
        setRetryingId(entryId);
        try {
            const result = await invoke('creator-hub:retry-publish', { historyEntryId: entryId });
            if (result.ok && result.success) {
                // Refresh history after successful retry
                await loadHistory();
                if (onRetry) onRetry();
            } else {
                // Show error briefly
                console.error('Retry failed:', result.error);
            }
        } catch (err) {
            console.error('Retry error:', err);
        } finally {
            setRetryingId(null);
        }
    }

    const filteredHistory = filter === 'all'
        ? history
        : history.filter(entry => entry.status === filter);

    const stats = {
        total: history.length,
        success: history.filter(e => e.status === 'success').length,
        failed: history.filter(e => e.status === 'failed').length,
        skipped: history.filter(e => e.status === 'skipped').length
    };

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Publishing History</div>

            {/* Stats */}
            <div className="chHistoryStats">
                <div className="chHistoryStat">
                    <span className="chHistoryStatValue">{stats.total}</span>
                    <span className="chHistoryStatLabel">Total</span>
                </div>
                <div className="chHistoryStat">
                    <span className="chHistoryStatValue chStatusSuccess">{stats.success}</span>
                    <span className="chHistoryStatLabel">Success</span>
                </div>
                <div className="chHistoryStat">
                    <span className="chHistoryStatValue chStatusError">{stats.failed}</span>
                    <span className="chHistoryStatLabel">Failed</span>
                </div>
                <div className="chHistoryStat">
                    <span className="chHistoryStatValue chStatusPending">{stats.skipped}</span>
                    <span className="chHistoryStatLabel">Skipped</span>
                </div>
            </div>

            {/* Filters */}
            <div className="chButtonGroup chFilterButtonGroup">
                {['all', 'success', 'failed', 'skipped'].map(f => (
                    <button
                        key={f}
                        type="button"
                        className={`chButton ${filter === f ? 'chButtonPrimary' : ''}`}
                        onClick={() => setFilter(f)}
                    >
                        {f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                ))}
            </div>

            {/* History List */}
            {loading ? (
                <div className="chEmpty">Loading history...</div>
            ) : filteredHistory.length === 0 ? (
                <div className="chEmpty">No publish history yet.</div>
            ) : (
                <div className="chHistoryList">
                    {filteredHistory.map(entry => (
                        <div key={entry.id} className="chHistoryEntry">
                            <div className="chHistoryEntryHeader">
                                <span className={`chStatus ${getStatusClass(entry.status)}`}>
                                    {entry.status}
                                </span>
                                <span className="chHistoryEntryPlatform">{entry.platform}</span>
                                <span className="chHistoryEntryTime">
                                    {formatDate(entry.startedAt)}
                                </span>
                            </div>
                            <div className="chHistoryEntryBody">
                                {entry.text && (
                                    <div className="chHistoryEntryText">
                                        {entry.text.length > 120
                                            ? `${entry.text.slice(0, 120)}...`
                                            : entry.text}
                                    </div>
                                )}
                                {entry.media && entry.media.length > 0 && (
                                    <div className="chHistoryEntryMeta">
                                        {entry.media.length} media file(s)
                                    </div>
                                )}
                                {entry.durationMs !== undefined && (
                                    <div className="chHistoryEntryMeta">
                                        Duration: {formatDuration(entry.durationMs)}
                                    </div>
                                )}
                                {entry.externalUrl && (
                                    <div className="chHistoryEntryMeta">
                                        <a
                                            href={entry.externalUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="chHistoryLink"
                                        >
                                            View Post
                                        </a>
                                    </div>
                                )}
                                {entry.errorMessage && (
                                    <div className="chHistoryEntryError">
                                        {entry.errorMessage}
                                    </div>
                                )}
                                {entry.status === 'failed' && (
                                    <div className="chRetryButton">
                                        <button
                                            type="button"
                                            className="chButton"
                                            onClick={() => handleRetry(entry.id)}
                                            disabled={retryingId === entry.id}
                                        >
                                            {retryingId === entry.id ? 'Retrying...' : 'Retry'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
