// src/creator-hub/ui/Accounts.jsx
// Account management view.

import { useState, useEffect } from 'react';
import { invoke } from '../../utils/electronApi.js';
import { ACCOUNT_STATUS } from '../../globals.js';
import { getPlatform } from '../../creator-hub/services/platforms.js';
import AccountPanel from './AccountPanel.jsx';

// Capabilities are loaded dynamically from the service via IPC

export default function Accounts({ onAccountAdded, onSelectAccountForCompose }) {
    const [accounts, setAccounts] = useState([]);
    const [selectedAccount, setSelectedAccount] = useState(null);
    const [error, setError] = useState('');
    const [authenticating, setAuthenticating] = useState(false);
    const [testingId, setTestingId] = useState(null);
    const [connectingId, setConnectingId] = useState(null);
    const [showForm, setShowForm] = useState(false);
    const [formPlatform, setFormPlatform] = useState(null);
    const [formData, setFormData] = useState({});
    const [submitting, setSubmitting] = useState(false);
    const [envLoaded, setEnvLoaded] = useState(false);
    const [envCredentials, setEnvCredentials] = useState({});
    const [threadsEnvStatus, setThreadsEnvStatus] = useState({ hasToken: false, authenticationMode: 'oauth' });

    useEffect(() => {
        loadAccounts();
        loadEnvCredentials();
        loadThreadsEnvStatus();
    }, []);

    async function loadEnvCredentials() {
        try {
            const result = await invoke('creator-hub:get-env-credentials');
            if (result.ok && result.credentials) {
                setEnvCredentials({
                    apiKey: result.credentials.apiKey || '',
                    apiSecret: result.credentials.apiSecret || '',
                    accessToken: result.credentials.accessToken || '',
                    accessTokenSecret: result.credentials.accessTokenSecret || '',
                    username: result.credentials.username || '',
                    blueskyAppSecret: result.credentials.blueskyAppSecret || '',
                    threadsAppId: result.credentials.threadsAppId || '',
                    threadsAppSecret: result.credentials.threadsAppSecret || '',
                    tiktokClientKey: result.credentials.tiktokClientKey || '',
                    tiktokClientSecret: result.credentials.tiktokClientSecret || '',
                    youtubeClientId: result.credentials.youtubeClientId || '',
                    youtubeClientSecret: result.credentials.youtubeClientSecret || ''
                });
                setEnvLoaded(true);
            }
        } catch (err) {
            // Silently fail — env credentials are optional
        }
    }

    async function loadThreadsEnvStatus() {
        try {
            const result = await invoke('creator-hub:get-threads-env-status');
            if (result.ok) {
                setThreadsEnvStatus({
                    hasToken: result.hasToken,
                    authenticationMode: result.authenticationMode
                });
            }
        } catch (err) {
            // Silently fail
        }
    }

    async function loadAccounts() {
        const result = await invoke('creator-hub:list-accounts');
        if (result.ok) {
            setAccounts(result.accounts);
        }
    }

    async function handleAuthenticate(platform) {
        setError('');
        setAuthenticating(true);

        try {
            const result = await invoke('creator-hub:authenticate-account', {
                platform,
                username: ''
            });

            if (result.ok) {
                await loadAccounts();
                if (onAccountAdded) onAccountAdded(result.account);
            } else {
                setError(result.error || 'Authentication failed');
            }
        } catch (err) {
            setError(err.message || 'Authentication failed');
        } finally {
            setAuthenticating(false);
        }
    }

    function getPlatformAuthLabel(platform) {
        switch (platform) {
            case 'instagram': return 'Connect Instagram';
            case 'threads':
                return threadsEnvStatus.hasToken ? 'Threads (Configured)' : 'Connect Threads';
            case 'tiktok': return 'Connect TikTok';
            case 'youtube': return 'Connect YouTube';
            default: return `Connect ${platform.charAt(0).toUpperCase() + platform.slice(1)}`;
        }
    }

    function getPlatformAuthDescription(platform) {
        switch (platform) {
            case 'instagram':
                return 'Connect your Instagram Creator or Business account via OAuth. This will open Meta\'s authorization page in your browser.';
            case 'threads':
                if (threadsEnvStatus.hasToken) {
                    return 'Threads is configured with an access token from your environment. Publishing will use this token directly. Click to re-authorize via OAuth if needed.';
                }
                return 'Connect your Threads account via Meta OAuth. This will open the Threads authorization page in your browser.';
            case 'tiktok':
                return 'Connect your TikTok account via OAuth. This will open TikTok\'s authorization page in your browser.';
            case 'youtube':
                return 'Connect your YouTube channel via Google OAuth. This will open Google\'s authorization page in your browser.';
            default:
                return `Connect your ${platform} account via OAuth.`;
        }
    }

    async function handleTest(accountId) {
        setError('');
        setTestingId(accountId);

        try {
            const result = await invoke('creator-hub:test-account', { accountId });
            if (result.ok && result.valid) {
                // Connection successful
            } else if (result.ok && !result.valid) {
                setError(result.error || 'Connection test failed');
            } else {
                setError(result.error || 'Test failed');
            }
        } catch (err) {
            setError(err.message || 'Test failed');
        } finally {
            setTestingId(null);
        }
    }

    async function handleDisconnect(accountId) {
        setError('');
        try {
            const result = await invoke('creator-hub:disconnect-account', { accountId });
            if (result.ok) {
                await loadAccounts();
            } else {
                setError(result.error || 'Failed to disconnect');
            }
        } catch (err) {
            setError(err.message || 'Failed to disconnect');
        }
    }

    function openForm(platform) {
        setFormPlatform(platform);
        setFormData({});
        setShowForm(true);
        setError('');
    }

    async function handleFormSubmit(e) {
        e.preventDefault();
        setError('');
        setSubmitting(true);

        try {
            if (formPlatform === 'x') {
                const { apiKey, apiSecret, accessToken, accessTokenSecret, username } = formData;
                if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
                    setError('All credential fields are required');
                    setSubmitting(false);
                    return;
                }

                const result = await invoke('creator-hub:add-account', {
                    platform: 'x',
                    username: username || 'twitter-user',
                    displayName: username || 'Twitter',
                    credentials: {
                        apiKey,
                        apiSecret,
                        accessToken,
                        accessTokenSecret
                    }
                });

                if (result.ok) {
                    setShowForm(false);
                    setFormData({});
                    await loadAccounts();
                    if (onAccountAdded) onAccountAdded(result.account);
                    if (result.warning) {
                        setError(result.warning);
                    }
                } else {
                    setError(result.error || 'Failed to add account');
                }
            } else if (formPlatform === 'bluesky') {
                const { identifier, password, username } = formData;
                if (!identifier || !password) {
                    setError('Identifier and password are required');
                    setSubmitting(false);
                    return;
                }

                const result = await invoke('creator-hub:add-account', {
                    platform: 'bluesky',
                    username: username || identifier,
                    displayName: username || identifier,
                    credentials: {
                        identifier,
                        password
                    }
                });

                if (result.ok) {
                    setShowForm(false);
                    setFormData({});
                    await loadAccounts();
                    if (onAccountAdded) onAccountAdded(result.account);
                    if (result.warning) {
                        setError(result.warning);
                    }
                } else {
                    setError(result.error || 'Failed to add account');
                }
            } else {
                // Generic access token form for other platforms
                const { accessToken, username, ...extraFields } = formData;
                if (!accessToken) {
                    setError('Access token is required');
                    setSubmitting(false);
                    return;
                }

                const credentials = { accessToken, ...extraFields };

                const result = await invoke('creator-hub:add-account', {
                    platform: formPlatform,
                    username: username || 'user',
                    displayName: username || 'User',
                    credentials
                });

                if (result.ok) {
                    setShowForm(false);
                    setFormData({});
                    await loadAccounts();
                    if (onAccountAdded) onAccountAdded(result.account);
                    if (result.warning) {
                        setError(result.warning);
                    }
                } else {
                    setError(result.error || 'Failed to add account');
                }
            }
        } catch (err) {
            setError(err.message || 'Failed to add account');
        } finally {
            setSubmitting(false);
        }
    }

    async function handleRemove(accountId) {
        setError('');
        try {
            const result = await invoke('creator-hub:remove-account', { accountId });
            if (result.ok) {
                if (selectedAccount?.id === accountId) {
                    setSelectedAccount(null);
                }
                await loadAccounts();
            } else {
                setError(result.error || 'Failed to remove account');
            }
        } catch (err) {
            setError(err.message || 'Failed to remove account');
        }
    }

    const supportedPlatforms = ['x', 'bluesky', 'mastodon', 'threads', 'instagram', 'facebook', 'youtube', 'tiktok'];
    const connectedPlatforms = new Set(accounts.map(a => a.platform));

    return (
        <div className="chPanel">
            <div className="chPanelHeader">Accounts</div>

            {error && (
                <div className="chAccountsError">
                    {error}
                </div>
            )}

            {selectedAccount && (
                <AccountPanel
                    account={selectedAccount}
                    platformMeta={getPlatform(selectedAccount.platform)}
                    onTest={() => handleTest(selectedAccount.id)}
                    onDisconnect={() => handleDisconnect(selectedAccount.id)}
                    onRemove={() => handleRemove(selectedAccount.id)}
                    testingId={testingId}
                />
            )}

            {!selectedAccount && !showForm && (
                <div>
                    <div className="chPanelHeader chConnectHeader">Connect Account</div>
                    <div className="chButtonGroup">
                        {supportedPlatforms.map(platform => {
                            const isConnected = connectedPlatforms.has(platform);
                            const isThreadsConfigured = platform === 'threads' && threadsEnvStatus.hasToken;
                            const disabled = isConnected;
                            const label = isConnected
                                ? 'Connected'
                                : isThreadsConfigured
                                    ? 'Threads (Configured)'
                                    : `Add ${platform.charAt(0).toUpperCase() + platform.slice(1)}`;
                            const title = isConnected
                                ? 'Already connected'
                                : isThreadsConfigured
                                    ? 'Threads configured via environment token — click to create account'
                                    : `Add ${platform} account`;
                            return (
                                <button
                                    key={platform}
                                    type="button"
                                    className="chButton"
                                    onClick={() => openForm(platform)}
                                    disabled={disabled}
                                    title={title}
                                >
                                    {label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="chPanelHeader chConnectHeader">Connected Accounts</div>
            {accounts.length === 0 ? (
                <div className="chEmpty">No accounts configured. Connect your first account above.</div>
            ) : (
                <ul className="chList">
                    {accounts.map(account => (
                        <li
                            key={account.id}
                            className="chListItem"
                        >
                            <div className="chAccountListItem" onClick={() => setSelectedAccount(account)}>
                                <div className="chListItemTitle">
                                    {account.displayName || account.username}
                                </div>
                                <div className="chListItemMeta">
                                    @{account.username}
                                </div>
                                <div>
                                    <span className={`chStatus chStatus${account.status.charAt(0).toUpperCase() + account.status.slice(1)}`}>
                                        {account.status}
                                    </span>
                                </div>
                            </div>
                            {onSelectAccountForCompose && account.status === 'connected' && (
                                <button
                                    type="button"
                                    className="chButton chButtonSmall chButtonPrimary chComposeButton"
                                    onClick={() => onSelectAccountForCompose(account)}
                                >
                                    Compose
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {!selectedAccount && showForm && (
                <div className="chAddAccountForm">
                    <div className="chPanelHeader chConnectHeader">
                        Add {formPlatform?.charAt(0).toUpperCase() + formPlatform?.slice(1)} Account
                    </div>
                    <form onSubmit={handleFormSubmit}>
                        {formPlatform === 'x' && (
                            <>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-username">Username</label>
                                    <input
                                        id="form-username"
                                        className="chInput"
                                        type="text"
                                        value={formData.username || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                                        placeholder="your_username"
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-apikey">API Key</label>
                                    <input
                                        id="form-apikey"
                                        className="chInput"
                                        type="text"
                                        value={formData.apiKey || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                                        placeholder="API Key"
                                        required
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-apisecret">API Secret</label>
                                    <input
                                        id="form-apisecret"
                                        className="chInput"
                                        type="password"
                                        value={formData.apiSecret || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, apiSecret: e.target.value }))}
                                        placeholder="API Secret"
                                        required
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-accesstoken">Access Token</label>
                                    <input
                                        id="form-accesstoken"
                                        className="chInput"
                                        type="text"
                                        value={formData.accessToken || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, accessToken: e.target.value }))}
                                        placeholder="Access Token"
                                        required
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-accesstokensecret">Access Token Secret</label>
                                    <input
                                        id="form-accesstokensecret"
                                        className="chInput"
                                        type="password"
                                        value={formData.accessTokenSecret || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, accessTokenSecret: e.target.value }))}
                                        placeholder="Access Token Secret"
                                        required
                                    />
                                </div>
                            </>
                        )}
                        {formPlatform === 'bluesky' && (
                            <>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-identifier">Identifier (handle or DID)</label>
                                    <input
                                        id="form-identifier"
                                        className="chInput"
                                        type="text"
                                        value={formData.identifier || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, identifier: e.target.value }))}
                                        placeholder="your-handle.bsky.social"
                                        required
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-password">App Password</label>
                                    <input
                                        id="form-password"
                                        className="chInput"
                                        type="password"
                                        value={formData.password || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, password: e.target.value }))}
                                        placeholder="App password"
                                        required
                                    />
                                    {envLoaded && envCredentials.blueskyAppSecret && (
                                        <button
                                            type="button"
                                            className="chButton chEnvPasswordButton"
                                            onClick={() => setFormData(prev => ({ ...prev, password: envCredentials.blueskyAppSecret }))}
                                        >
                                            Use env password
                                        </button>
                                    )}
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-username">Username (optional)</label>
                                    <input
                                        id="form-username"
                                        className="chInput"
                                        type="text"
                                        value={formData.username || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                                        placeholder="Display name"
                                    />
                                </div>
                            </>
                        )}
                        {formPlatform === 'instagram' && (
                            <>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-username">Instagram Username</label>
                                    <input
                                        id="form-username"
                                        className="chInput"
                                        type="text"
                                        value={formData.username || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                                        placeholder="e.g. ceferial"
                                    />
                                    <div style={{ fontSize: '0.85em', color: '#888', marginTop: '0.3rem' }}>
                                        Optional. Will be retrieved automatically from Instagram after connecting.
                                    </div>
                                </div>
                                <div className="chFormGroup" style={{ marginTop: '1rem' }}>
                                    <p style={{ color: '#ccc', marginBottom: '0.5rem' }}>
                                        {getPlatformAuthDescription('instagram')}
                                    </p>
                                    <button
                                        type="button"
                                        className="chButton chButtonPrimary"
                                        onClick={() => handleAuthenticate('instagram')}
                                        disabled={authenticating}
                                        style={{ width: '100%', padding: '0.8rem' }}
                                    >
                                        {authenticating ? (
                                            <>
                                                <span className="chSpinner" style={{ display: 'inline-block', width: '16px', height: '16px', border: '2px solid #000', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', marginRight: '0.5rem', verticalAlign: 'middle' }}></span>
                                                Connecting to Instagram...
                                            </>
                                        ) : (
                                            getPlatformAuthLabel('instagram')
                                        )}
                                    </button>
                                    {envLoaded && envCredentials.apiKey && (
                                        <div style={{ fontSize: '0.85em', color: '#4f4', marginTop: '0.5rem' }}>
                                            Instagram API credentials found in environment configuration.
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                        {(formPlatform === 'threads' || formPlatform === 'tiktok' || formPlatform === 'youtube') && (
                            <>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-username">Username / Channel Name</label>
                                    <input
                                        id="form-username"
                                        className="chInput"
                                        type="text"
                                        value={formData.username || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                                        placeholder={`Your ${formPlatform} username`}
                                    />
                                    <div style={{ fontSize: '0.85em', color: '#888', marginTop: '0.3rem' }}>
                                        Optional. Will be retrieved automatically after connecting.
                                    </div>
                                </div>
                                <div className="chFormGroup" style={{ marginTop: '1rem' }}>
                                    <p style={{ color: '#ccc', marginBottom: '0.5rem' }}>
                                        {getPlatformAuthDescription(formPlatform)}
                                    </p>
                                    <button
                                        type="button"
                                        className="chButton chButtonPrimary"
                                        onClick={() => handleAuthenticate(formPlatform)}
                                        disabled={authenticating}
                                        style={{ width: '100%', padding: '0.8rem' }}
                                    >
                                        {authenticating ? (
                                            <>
                                                <span className="chSpinner" style={{ display: 'inline-block', width: '16px', height: '16px', border: '2px solid #000', borderTop: '2px solid transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', marginRight: '0.5rem', verticalAlign: 'middle' }}></span>
                                                Connecting to {formPlatform.charAt(0).toUpperCase() + formPlatform.slice(1)}...
                                            </>
                                        ) : (
                                            getPlatformAuthLabel(formPlatform)
                                        )}
                                    </button>
                                    {envLoaded && (
                                        <div style={{ fontSize: '0.85em', marginTop: '0.5rem' }}>
                                            {formPlatform === 'threads' && envCredentials.threadsAppId && (
                                                <span style={{ color: '#4f4' }}>Threads API credentials found in environment configuration.</span>
                                            )}
                                            {formPlatform === 'tiktok' && envCredentials.tiktokClientKey && (
                                                <span style={{ color: '#4f4' }}>TikTok API credentials found in environment configuration.</span>
                                            )}
                                            {formPlatform === 'youtube' && envCredentials.youtubeClientId && (
                                                <span style={{ color: '#4f4' }}>YouTube API credentials found in environment configuration.</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                        {formPlatform && !['x', 'bluesky', 'instagram', 'threads', 'tiktok', 'youtube'].includes(formPlatform) && (
                            <>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-username">Username</label>
                                    <input
                                        id="form-username"
                                        className="chInput"
                                        type="text"
                                        value={formData.username || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
                                        placeholder="your_username"
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="form-accesstoken">Access Token</label>
                                    <input
                                        id="form-accesstoken"
                                        className="chInput"
                                        type="text"
                                        value={formData.accessToken || ''}
                                        onChange={e => setFormData(prev => ({ ...prev, accessToken: e.target.value }))}
                                        placeholder="Access token"
                                        required
                                    />
                                </div>
                            </>
                        )}
                        <div className="chButtonGroup">
                            <button
                                type="submit"
                                className="chButton chButtonPrimary"
                                disabled={submitting}
                            >
                                {submitting ? 'Adding...' : 'Add Account'}
                            </button>
                            <button
                                type="button"
                                className="chButton"
                                onClick={() => { setShowForm(false); setFormData({}); }}
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
