// src/creator-hub/ui/PublishProgress.jsx
// Step-by-step publishing progress indicator.
// Shows connection test, media upload, and publish status per platform.

function getStatusLabel(status) {
    switch (status) {
        case 'pending': return 'Waiting';
        case 'testing': return 'Testing connection';
        case 'uploading': return 'Uploading media';
        case 'publishing': return 'Publishing';
        case 'success': return 'Published';
        case 'failed': return 'Failed';
        case 'skipped': return 'Skipped';
        default: return status;
    }
}

export default function PublishProgress({ results, platforms, isPublishing }) {
    if (!isPublishing && results.length === 0) {
        return null;
    }

    return (
        <div className="chPublishProgress">
            <div className="chPublishProgressHeader">
                {isPublishing ? 'Publishing...' : 'Publish Complete'}
            </div>
            <div className="chPublishProgressList">
                {platforms.map(platform => {
                    const result = results.find(r => r.platform === platform);
                    const status = result?.status || 'pending';
                    const error = result?.error;

                    return (
                        <div key={platform} className={`chPublishProgressItem chPublishProgressItem--${status}`}>
                            <span className="chPublishProgressPlatform">{platform}</span>
                            <span className="chPublishProgressStatus">
                                {getStatusLabel(status)}
                            </span>
                            {error && (
                                <span className="chPublishProgressError" title={error}>
                                    {error.length > 40 ? `${error.slice(0, 40)}...` : error}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
