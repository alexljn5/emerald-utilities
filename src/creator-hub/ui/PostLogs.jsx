// src/creator-hub/ui/PostLogs.jsx
// Detailed publish log metadata view.

import { useState } from 'react';
import { formatDateTime } from '../../utils/dateUtils.js';

const dateOpts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };

function formatDuration(ms) {
    if (!ms && ms !== 0) return 'N/A';
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

export default function PostLogs({ log, onBack }) {
    if (!log) {
        return (
            <div className="chPanel">
                <div className="chPanelHeader">Publish Log Details</div>
                <div className="chEmpty">Select a log entry from the sidebar to view details.</div>
            </div>
        );
    }

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Publish Log Details</div>

            <div className="chBackButton">
                <button
                    type="button"
                    className="chButton"
                    onClick={onBack}
                >
                    Back to Logs
                </button>
            </div>

            <div className="chLogDetail">
                <div className="chLogDetailRow">
                    <span className="chLogDetailLabel">Log ID</span>
                    <span className="chLogDetailValue">{log.id}</span>
                </div>
                <div className="chLogDetailRow">
                    <span className="chLogDetailLabel">Platform</span>
                    <span className="chLogDetailValue">{log.platform}</span>
                </div>
                <div className="chLogDetailRow">
                    <span className="chLogDetailLabel">Status</span>
                    <span className={`chStatus ${getStatusClass(log.status)}`}>
                        {log.status}
                    </span>
                </div>
                <div className="chLogDetailRow">
                    <span className="chLogDetailLabel">Started At</span>
                    <span className="chLogDetailValue">{log.startedAt ? formatDateTime(log.startedAt, dateOpts) : 'N/A'}</span>
                </div>
                <div className="chLogDetailRow">
                    <span className="chLogDetailLabel">Duration</span>
                    <span className="chLogDetailValue">{formatDuration(log.durationMs)}</span>
                </div>
                {log.accountId && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">Account ID</span>
                        <span className="chLogDetailValue">{log.accountId}</span>
                    </div>
                )}
                {log.postId && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">Post ID</span>
                        <span className="chLogDetailValue">{log.postId}</span>
                    </div>
                )}
                {log.text && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">Content</span>
                        <span className="chLogDetailValue">{log.text.length > 200 ? `${log.text.slice(0, 200)}...` : log.text}</span>
                    </div>
                )}
                {log.media && log.media.length > 0 && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">Media</span>
                        <span className="chLogDetailValue">{log.media.length} file(s)</span>
                    </div>
                )}
                {log.externalUrl && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">External URL</span>
                        <span className="chLogDetailValue">
                            <a href={log.externalUrl} target="_blank" rel="noopener noreferrer" className="chHistoryLink">
                                View Post
                            </a>
                        </span>
                    </div>
                )}
                {log.errorMessage && (
                    <div className="chLogDetailRow">
                        <span className="chLogDetailLabel">Error</span>
                        <span className="chLogDetailValue chLogDetailError">{log.errorMessage}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
