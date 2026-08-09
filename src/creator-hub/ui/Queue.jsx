// src/creator-hub/ui/Queue.jsx
// Publishing queue: shows publish results.

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';

export default function Queue() {
    const [results, setResults] = useState([]);

    useEffect(() => {
        // In a real implementation, we'd load publish history from storage
        // For now, this is a placeholder that shows the structure
        loadResults();
    }, []);

    async function loadResults() {
        // Placeholder: results would be stored in posts or a separate history file
        setResults([]);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Publish Queue</div>
            {results.length === 0 ? (
                <div className="chEmpty">No publish history yet.</div>
            ) : (
                <ul className="chList">
                    {results.map((result, idx) => (
                        <li key={idx} className="chListItem">
                            <div className="chListItemTitle">
                                Post: {result.postId?.slice(0, 8) || 'unknown'}
                            </div>
                            <div className="chListItemMeta">
                                {formatDate(result.startedAt)} - {formatDate(result.finishedAt)}
                            </div>
                            <div>
                                {result.results?.map((r, i) => (
                                    <div key={i}>
                                        <span className={`chStatus ${r.success ? 'chStatusSuccess' : 'chStatusError'}`}>
                                            {r.platform}
                                        </span>
                                        <span>
                                            {r.success ? 'Published' : (r.error || 'Failed')}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
