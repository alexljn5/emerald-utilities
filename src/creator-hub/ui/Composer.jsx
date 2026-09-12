// src/creator-hub/ui/Composer.jsx
// Platform-aware post composer — two modes:
//   - Single-account: opened from dashboard card, no overrides, platform-specific fields
//   - Multi-platform: opened from Composer tab, supports multiple targets with overrides

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';
import { ACCOUNT_STATUS } from '../../globals.js';
import { getPlatform } from '../../creator-hub/services/platforms.js';
import '../../css/creator-hub.css';
import PublishProgress from './PublishProgress.jsx';

export default function Composer({ selectedAccount = null, onPostCreated, editingPost = null, onCancelEdit, onBack }) {
    // ==================== MODE ====================
    // single: one known account, no overrides
    // multi: user selects targets, overrides per platform
    const mode = selectedAccount ? 'single' : 'multi';

    // ==================== CONTENT ====================
    const [message, setMessage] = useState('');
    const [media, setMedia] = useState([]);
    const [tags, setTags] = useState('');
    const [instagramOptions, setInstagramOptions] = useState({
        frame: 'original',
        coverPath: ''
    });

    // ==================== MULTI-PLATFORM TARGETS ====================
    const [targets, setTargets] = useState([]);
    const [accounts, setAccounts] = useState([]);
    const [overrides, setOverrides] = useState({});

    // ==================== PUBLISHING ====================
    const [loading, setLoading] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [publishResults, setPublishResults] = useState([]);
    const [error, setError] = useState('');
    const [currentPostId, setCurrentPostId] = useState(null);

    // Load accounts for multi-platform mode
    useEffect(() => {
        if (mode === 'multi') {
            loadAccounts();
        }
    }, [mode]);

    // Load editing post
    useEffect(() => {
        if (editingPost) {
            setMessage(editingPost.message || '');
            setMedia(editingPost.media || []);
            setTags((editingPost.tags || []).join(', '));
            setInstagramOptions({
                frame: editingPost.instagramOptions?.frame || 'original',
                coverPath: editingPost.instagramOptions?.coverPath || ''
            });
            if (editingPost.targets) {
                setTargets(editingPost.targets);
            }
            if (editingPost.overrides) {
                setOverrides(editingPost.overrides);
            }
        }
    }, [editingPost]);

    async function loadAccounts() {
        const result = await invoke('creator-hub:list-accounts');
        if (result.ok) {
            setAccounts(result.accounts.filter(a => a.status === ACCOUNT_STATUS.CONNECTED));
        }
    }

    // ==================== MEDIA MANAGEMENT ====================

    async function handleMediaSelect() {
        const result = await invoke('creator-hub:open-file-dialog');
        if (!result.ok || !result.files?.length) return;

        const newMedia = result.files.map(filePath => {
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const ext = fileName.includes('.') ? '.' + fileName.split('.').pop().toLowerCase() : '';
            const mimeMap = {
                '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp',
                '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm'
            };
            return {
                path: filePath,
                name: fileName,
                type: mimeMap[ext] || 'application/octet-stream',
                size: 0 // Will be resolved by mediaHandler if needed
            };
        });

        setMedia(prev => [...prev, ...newMedia]);
    }

    function handleMediaRemove(index) {
        setMedia(prev => prev.filter((_, i) => i !== index));
    }

    async function handleInstagramCoverSelect(accountId = null) {
        const result = await invoke('creator-hub:open-file-dialog');
        if (!result.ok || !result.files?.length) return;

        const coverPath = result.files[0];
        if (accountId) {
            handleOverrideChange(accountId, 'instagramOptions', {
                ...(overrides[accountId]?.instagramOptions || {}),
                coverPath
            });
            return;
        }

        setInstagramOptions(prev => ({ ...prev, coverPath }));
    }

    function handleInstagramFrameChange(frame, accountId = null) {
        if (accountId) {
            handleOverrideChange(accountId, 'instagramOptions', {
                ...(overrides[accountId]?.instagramOptions || {}),
                frame
            });
            return;
        }

        setInstagramOptions(prev => ({ ...prev, frame }));
    }

    // ==================== TARGET MANAGEMENT (MULTI MODE) ====================

    function handleTargetToggle(accountId) {
        setTargets(prev => {
            const existing = prev.find(t => t.accountId === accountId);
            if (existing) {
                return prev.filter(t => t.accountId !== accountId);
            } else {
                const account = accounts.find(a => a.id === accountId);
                return [...prev, {
                    accountId,
                    platform: account?.platform || '',
                    enabled: true,
                    override: {}
                }];
            }
        });
        setOverrides(prev => {
            const next = { ...prev };
            delete next[accountId];
            return next;
        });
    }

    // ==================== OVERRIDE MANAGEMENT (MULTI MODE) ====================

    function handleOverrideChange(accountId, field, value) {
        setOverrides(prev => ({
            ...prev,
            [accountId]: {
                ...prev[accountId],
                [field]: value
            }
        }));
    }

    function handleOverrideMediaToggle(accountId, mediaPath) {
        setOverrides(prev => {
            const current = prev[accountId]?.media || [];
            const next = current.includes(mediaPath)
                ? current.filter(m => m !== mediaPath)
                : [...current, mediaPath];
            return {
                ...prev,
                [accountId]: {
                    ...prev[accountId],
                    media: next
                }
            };
        });
    }

    // ==================== VALIDATION ====================

    function getCharCount(text) {
        return text ? text.length : 0;
    }

    function validatePublish() {
        const issues = [];

        if (!message.trim()) {
            issues.push({ reason: 'Message is empty', fix: 'Add content before publishing.' });
        }

        if (mode === 'single' && selectedAccount) {
            const platformMeta = getPlatform(selectedAccount.platform);
            const caps = platformMeta?.capabilities || {};
            const mediaRules = platformMeta?.mediaRules || {};
            const effectiveMessage = message;

            // Character limit check
            if (caps.maxChars > 0 && getCharCount(effectiveMessage) > caps.maxChars) {
                issues.push({ reason: `Text exceeds ${caps.maxChars} character limit`, fix: `Keep message under ${caps.maxChars} characters.` });
            }

            // Media required check (e.g. Instagram requires at least one image)
            const minFiles = mediaRules.minFiles || 0;
            if (minFiles > 0 && media.length < minFiles) {
                issues.push({
                    reason: `${selectedAccount.platform} requires at least ${minFiles} media file(s)`,
                    fix: `Add ${minFiles === 1 ? 'an image' : 'images'} to your post. ${selectedAccount.platform} does not support text-only posts.`
                });
            }
        }

        if (mode === 'multi') {
            const enabledTargets = targets.filter(t => t.enabled);
            if (enabledTargets.length === 0) {
                issues.push({ reason: 'No targets selected', fix: 'Select at least one platform to publish to.' });
            }

            for (const target of enabledTargets) {
                const platformMeta = getPlatform(target.platform);
                const caps = platformMeta?.capabilities || {};
                const mediaRules = platformMeta?.mediaRules || {};
                const overrideMsg = overrides[target.accountId]?.message || message;
                const targetMedia = overrides[target.accountId]?.media || (target.enabled ? media.map(m => m.path) : []);

                // Character limit check
                if (caps.maxChars > 0 && getCharCount(overrideMsg) > caps.maxChars) {
                    issues.push({ reason: `${target.platform}: Text exceeds ${caps.maxChars} character limit`, fix: `Keep message under ${caps.maxChars} characters for ${target.platform}.` });
                }

                // Media required check (e.g. Instagram requires at least one image)
                const minFiles = mediaRules.minFiles || 0;
                if (minFiles > 0 && targetMedia.length < minFiles) {
                    issues.push({
                        reason: `${target.platform} requires at least ${minFiles} media file(s)`,
                        fix: `Add ${minFiles === 1 ? 'an image' : 'images'} to your post for ${target.platform}. It does not support text-only posts.`
                    });
                }
            }
        }

        return issues;
    }

    // ==================== SUBMISSION ====================

    async function handleSubmit(e) {
        e.preventDefault();
        setError('');
        setLoading(true);
        setPublishing(false);
        setPublishResults([]);

        try {
            let postTargets = [];
            let postOverrides = {};

            if (mode === 'single' && selectedAccount) {
                postTargets = [{
                    accountId: selectedAccount.id,
                    platform: selectedAccount.platform,
                    enabled: true,
                    override: {}
                }];
            } else if (mode === 'multi') {
                postTargets = targets;
                postOverrides = overrides;
            }

            const postData = {
                id: editingPost?.id || `post-${Date.now()}`,
                message: message.trim(),
                media: media,
                tags: tags.split(',').map(t => t.trim()).filter(Boolean),
                instagramOptions,
                targets: postTargets,
                overrides: postOverrides,
                createdAt: editingPost?.createdAt || new Date().toISOString()
            };

            const result = await invoke('creator-hub:create-post', postData);
            if (result.ok) {
                setCurrentPostId(result.post.id);

                // Reset form
                setMessage('');
                setMedia([]);
                setTags('');
                setInstagramOptions({ frame: 'original', coverPath: '' });
                setTargets([]);
                setOverrides({});

                // Publish
                const enabledTargets = postTargets.filter(t => t.enabled);
                if (enabledTargets.length > 0) {
                    setPublishing(true);
                    const publishResult = await invoke('creator-hub:publish', { postId: result.post.id });
                    setPublishing(false);
                    if (publishResult.ok && publishResult.summary) {
                        setPublishResults(publishResult.summary.results || []);
                    } else {
                        setError(publishResult.error || 'Post saved but publishing failed');
                    }
                }

                if (onPostCreated) onPostCreated(result.post);
            } else {
                setError(result.error || 'Failed to create post');
            }
        } catch (err) {
            setError(err.message || 'Failed to create post');
            setPublishing(false);
        } finally {
            setLoading(false);
        }
    }

    // ==================== RENDERING ====================

    const validationIssues = validatePublish();

    // Single-account mode: no account selected yet
    if (mode === 'single' && !selectedAccount) {
        return (
            <div className="chPanel">
                <div className="chPanelHeader">New Post</div>
                <div className="chEmpty">
                    Select an account from the Dashboard to start composing.
                </div>
                {onBack && (
                    <button type="button" className="chButton" onClick={onBack}>
                        Back to Dashboard
                    </button>
                )}
            </div>
        );
    }

    const platformMeta = selectedAccount ? getPlatform(selectedAccount.platform) : null;
    const capabilities = platformMeta?.capabilities || { text: true, images: false, video: false, maxChars: 0 };
    const mediaRules = platformMeta?.mediaRules || {};
    const isSingleInstagram = mode === 'single' && selectedAccount?.platform === 'instagram';

    return (
        <form className="chPanel" onSubmit={handleSubmit}>
            <div className="chPanelHeader">
                {editingPost ? 'Edit Post' : mode === 'single' ? `Create ${selectedAccount?.platform} Post` : 'Create Multi Platform Post'}
            </div>

            {error && (
                <div className="chComposerError">
                    {error}
                </div>
            )}

            {/* Account info (single mode) */}
            {mode === 'single' && selectedAccount && (
                <div className="chAccountInfo">
                    <div>
                        <strong>{selectedAccount.platform}</strong>
                        <div>@{selectedAccount.username}</div>
                    </div>
                    <div className="chAccountInfoMeta">
                        {capabilities.text && <span className="chCapabilityText">Text</span>}
                        {capabilities.images && <span className="chCapabilityText">Images</span>}
                        {capabilities.video && <span className="chCapabilityText">Video</span>}
                        {capabilities.maxChars > 0 && <span className="chCharLimit">{capabilities.maxChars} chars</span>}
                    </div>
                </div>
            )}

            {/* ==================== CONTENT ==================== */}
            <div className="chFormGroup">
                <label className="chLabel" htmlFor="post-message">Message</label>
                <textarea
                    id="post-message"
                    className="chTextarea"
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="What do you want to say?"
                    required
                />
                <div className="chCharCounter">
                    {getCharCount(message)} characters
                </div>
            </div>

            {/* Media — only if platform supports images or video (single mode) or always (multi mode) */}
            {(mode === 'single' ? (capabilities.images || capabilities.video) : true) && (
                <div className="chFormGroup">
                    <label className="chLabel">Media</label>
                    <button
                        type="button"
                        className="chButton chButtonSecondary chMediaAddButton"
                        onClick={handleMediaSelect}
                    >
                        + Add Media
                    </button>
                    {media.length > 0 && (
                        <div className="chMediaPreview">
                            {media.map((file, index) => (
                                <div key={index} className="chMediaItem">
                                    <div className="chMediaInfo">
                                        <span className="chMediaName">{file.name || `File ${index + 1}`}</span>
                                        <span className="chMediaSize">
                                            {file.size ? `${(file.size / 1024).toFixed(1)} KB` : ''}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className="chButton chButtonSmall chButtonDanger"
                                        onClick={() => handleMediaRemove(index)}
                                    >
                                        Remove
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Tags */}
            <div className="chFormGroup">
                <label className="chLabel" htmlFor="post-tags">Hashtags</label>
                <input
                    id="post-tags"
                    className="chInput"
                    type="text"
                    value={tags}
                    onChange={e => setTags(e.target.value)}
                    placeholder="#gamedev #indiedev"
                />
            </div>

            {isSingleInstagram && (
                <div className="chFormGroup">
                    <label className="chLabel">Instagram Frame</label>
                    <div className="chSegmentedControl">
                        {[
                            ['original', 'Original'],
                            ['boxed', 'Boxed'],
                            ['portrait-9-16', '9:16']
                        ].map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={`chSegment ${instagramOptions.frame === value ? 'chSegment--active' : ''}`}
                                onClick={() => handleInstagramFrameChange(value)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="chFormHelper">Saved with the Instagram post for desktop-style media preparation.</div>
                </div>
            )}

            {isSingleInstagram && (
                <div className="chFormGroup">
                    <label className="chLabel">Cover Photo</label>
                    <div className="chInlineControl">
                        <button
                            type="button"
                            className="chButton chButtonSecondary"
                            onClick={() => handleInstagramCoverSelect()}
                        >
                            Select Cover
                        </button>
                        <span className="chInlineMeta">
                            {instagramOptions.coverPath ? instagramOptions.coverPath.split(/[\\/]/).pop() : 'No cover selected'}
                        </span>
                    </div>
                </div>
            )}

            {/* ==================== MULTI-PLATFORM TARGETS ==================== */}
            {mode === 'multi' && (
                <div className="chFormGroup">
                    <label className="chLabel">Targets</label>
                    {accounts.length === 0 ? (
                        <div className="chEmpty">No connected accounts. Add accounts in the Accounts page.</div>
                    ) : (
                        <div className="chTargetList">
                            {accounts.map(account => {
                                const target = targets.find(t => t.accountId === account.id);
                                const isSelected = !!target;
                                const caps = getPlatform(account.platform)?.capabilities || {};

                                return (
                                    <div key={account.id} className="chTargetItem">
                                        <div className="chTargetInfo">
                                            <span className="chTargetPlatform">{account.platform}</span>
                                            <span className="chTargetUsername">@{account.username}</span>
                                            <div className="chTargetCapabilities">
                                                {caps.text && <span className="chCapabilityText">Text</span>}
                                                {caps.images && <span className="chCapabilityText">Images</span>}
                                                {caps.video && <span className="chCapabilityText">Video</span>}
                                            </div>
                                        </div>
                                        <div className="chTargetActions">
                                            <label className="chToggle">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => handleTargetToggle(account.id)}
                                                />
                                                <span className="chToggleSlider"></span>
                                            </label>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ==================== MULTI-PLATFORM OVERRIDES ==================== */}
            {mode === 'multi' && targets.some(t => t.enabled) && (
                <div className="chFormGroup">
                    <label className="chLabel">Platform Adjustments (optional)</label>
                    {targets.filter(t => t.enabled).map(target => {
                        const account = accounts.find(a => a.id === target.accountId);
                        const caps = getPlatform(target.platform)?.capabilities || {};
                        const override = overrides[target.accountId] || {};

                        return (
                            <div key={target.accountId} className="chOverridePanel">
                                <div className="chTargetPlatform">
                                    {target.platform} — @{account?.username}
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor={`override-message-${target.accountId}`}>Message override</label>
                                    <textarea
                                        id={`override-message-${target.accountId}`}
                                        className="chTextarea"
                                        value={override.message || ''}
                                        onChange={e => handleOverrideChange(target.accountId, 'message', e.target.value)}
                                        placeholder={`Custom text for ${target.platform} (optional)...`}
                                        rows={2}
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor={`override-tags-${target.accountId}`}>Hashtags override</label>
                                    <input
                                        id={`override-tags-${target.accountId}`}
                                        className="chInput"
                                        type="text"
                                        value={(override.tags || []).join(', ')}
                                        onChange={e => handleOverrideChange(target.accountId, 'tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                                        placeholder="gamedev, indie (optional)"
                                    />
                                </div>
                                {(caps.images || caps.video) && media.length > 0 && (
                                    <div className="chFormGroup">
                                        <label className="chLabel">Media for {target.platform}</label>
                                        <div className="chOverrideMediaList">
                                            {media.map((file, index) => {
                                                const isSelected = (override.media || []).includes(file.path);
                                                return (
                                                    <div
                                                        key={index}
                                                        className={`chOverrideMediaItem ${isSelected ? 'chOverrideMediaItem--selected' : ''}`}
                                                        onClick={() => handleOverrideMediaToggle(target.accountId, file.path)}
                                                    >
                                                        <span>{file.name || `File ${index + 1}`}</span>
                                                        <span>{isSelected ? '✓' : '○'}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                                {target.platform === 'instagram' && (
                                    <>
                                        <div className="chFormGroup">
                                            <label className="chLabel">Instagram frame</label>
                                            <div className="chSegmentedControl">
                                                {[
                                                    ['original', 'Original'],
                                                    ['boxed', 'Boxed'],
                                                    ['portrait-9-16', '9:16']
                                                ].map(([value, label]) => (
                                                    <button
                                                        key={value}
                                                        type="button"
                                                        className={`chSegment ${(override.instagramOptions?.frame || instagramOptions.frame) === value ? 'chSegment--active' : ''}`}
                                                        onClick={() => handleInstagramFrameChange(value, target.accountId)}
                                                    >
                                                        {label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="chFormGroup">
                                            <label className="chLabel">Cover photo</label>
                                            <div className="chInlineControl">
                                                <button
                                                    type="button"
                                                    className="chButton chButtonSecondary"
                                                    onClick={() => handleInstagramCoverSelect(target.accountId)}
                                                >
                                                    Select Cover
                                                </button>
                                                <span className="chInlineMeta">
                                                    {override.instagramOptions?.coverPath ? override.instagramOptions.coverPath.split(/[\\/]/).pop() : 'Using base cover'}
                                                </span>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ==================== VALIDATION ==================== */}
            {validationIssues.length > 0 && (
                <div className="chValidationBox">
                    {validationIssues.map((issue, i) => (
                        <div key={i} className="chValidationIssue">
                            <strong>{mode === 'single' && selectedAccount ? selectedAccount.platform : 'Publish'} cannot publish:</strong>
                            <div>Reason: {issue.reason}</div>
                            <div>Fix: {issue.fix}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* ==================== ACTIONS ==================== */}
            <div className="chButtonGroup">
                {mode === 'multi' && accounts.length > 0 && (
                    <button
                        type="button"
                        className="chButton chButtonSecondary"
                        onClick={() => {
                            // Select all connected accounts as targets
                            const allTargets = accounts.map(a => ({
                                accountId: a.id,
                                platform: a.platform,
                                enabled: true,
                                override: {}
                            }));
                            setTargets(allTargets);
                        }}
                        disabled={loading || publishing}
                    >
                        Publish Everywhere
                    </button>
                )}
                <button
                    type="submit"
                    className="chButton chButtonPrimary"
                    disabled={loading || publishing || validationIssues.length > 0}
                >
                    {publishing ? 'Publishing...' : loading ? 'Saving...' : 'Publish'}
                </button>
                {onCancelEdit && (
                    <button
                        type="button"
                        className="chButton"
                        onClick={onCancelEdit}
                        disabled={loading || publishing}
                    >
                        Cancel
                    </button>
                )}
                {onBack && !editingPost && (
                    <button
                        type="button"
                        className="chButton"
                        onClick={onBack}
                        disabled={loading || publishing}
                    >
                        Back
                    </button>
                )}
            </div>

            {/* ==================== PUBLISH PROGRESS ==================== */}
            {(publishing || publishResults.length > 0) && (
                <PublishProgress
                    results={publishResults}
                    platforms={targets.filter(t => t.enabled).map(t => t.platform)}
                    isPublishing={publishing}
                    onRetry={async (historyEntryId) => {
                        const retryResult = await invoke('creator-hub:retry-publish', { historyEntryId });
                        if (retryResult.ok && retryResult.success) {
                            // Refresh results by re-publishing
                            if (currentPostId) {
                                const newPublishResult = await invoke('creator-hub:publish', { postId: currentPostId });
                                if (newPublishResult.ok && newPublishResult.summary) {
                                    setPublishResults(newPublishResult.summary.results || []);
                                }
                            }
                        } else {
                            setError(retryResult.error || 'Retry failed');
                        }
                    }}
                />
            )}
        </form>
    );
}
