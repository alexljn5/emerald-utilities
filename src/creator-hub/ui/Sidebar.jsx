// src/creator-hub/ui/Sidebar.jsx
// Left panel: navigation and recent activity.

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';

export default function Sidebar({ onSelectPost, selectedPostId, currentView, onViewChange, onSelectLog }) {
    const [posts, setPosts] = useState([]);
    const [logs, setLogs] = useState([]);

    useEffect(() => {
        loadPosts();
        loadLogs();
    }, []);

    useEffect(() => {
        if (currentView) {
            // view is managed by parent
        }
    }, [currentView]);

    async function loadPosts() {
        const result = await invoke('creator-hub:list-posts');
        if (result.ok) {
            setPosts(result.posts);
        }
    }

    async function loadLogs() {
        const result = await invoke('creator-hub:list-publish-history');
        if (result.ok) {
            setLogs(result.history || []);
        }
    }

    function handleViewChange(newView) {
        if (onViewChange) onViewChange(newView);
    }

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

    return (
        <div className="creatorHubLeft">
            <div className="chPanel">
                <div className="chPanelHeader">Creator Hub</div>
                <div className="chButtonGroup">
                    <button
                        type="button"
                        className={`chButton ${currentView === 'dashboard' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('dashboard')}
                    >
                        Dashboard
                    </button>
                    <button
                        type="button"
                        className={`chButton ${currentView === 'accounts' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('accounts')}
                    >
                        Accounts
                    </button>
                    <button
                        type="button"
                        className={`chButton ${currentView === 'composer' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('composer')}
                    >
                        Composer
                    </button>
                    <button
                        type="button"
                        className={`chButton ${currentView === 'queue' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('queue')}
                    >
                        Queue
                    </button>
                    <button
                        type="button"
                        className={`chButton ${currentView === 'history' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('history')}
                    >
                        History
                    </button>
                    <button
                        type="button"
                        className={`chButton ${currentView === 'logs' ? 'chButtonPrimary' : ''}`}
                        onClick={() => handleViewChange('logs')}
                    >
                        Logs
                    </button>
                </div>
            </div>

            <div className="chPanel">
                <div className="chPanelHeader">Recent Posts</div>
                {posts.length === 0 ? (
                    <div className="chEmpty">No posts yet. Create your first post.</div>
                ) : (
                    <ul className="chList">
                        {posts.map(post => (
                            <li
                                key={post.id}
                                className={`chListItem ${selectedPostId === post.id ? 'chListItemActive chSidebarActive' : ''}`}
                                onClick={() => onSelectPost && onSelectPost(post)}
                            >
                                <div className="chListItemTitle">
                                    {post.title || (post.message || '').slice(0, 50) || 'Untitled'}
                                </div>
                                <div className="chListItemMeta">
                                    {formatDate(post.createdAt)}
                                </div>
                                {(post.tags || []).length > 0 && (
                                    <div className="chSidebarTag">
                                        {(post.tags || []).slice(0, 3).map(tag => (
                                            <span key={tag} className="chTag">{tag}</span>
                                        ))}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="chPanel">
                <div className="chPanelHeader">Publish Logs</div>
                {logs.length === 0 ? (
                    <div className="chEmpty">No publish logs yet.</div>
                ) : (
                    <ul className="chList">
                        {logs.map(log => (
                            <li
                                key={log.id}
                                className="chListItem"
                                onClick={() => onSelectLog && onSelectLog(log)}
                            >
                                <div className="chListItemTitle">
                                    {log.platform} - {log.status}
                                </div>
                                <div className="chListItemMeta">
                                    ID: {log.id.slice(0, 8)}...
                                </div>
                                <div className="chListItemMeta">
                                    {formatDate(log.startedAt)}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
