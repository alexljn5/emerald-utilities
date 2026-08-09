import { useEffect, useRef, useState, useCallback } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../utils/electronApi.js';
import '../css/settings.css';

const DEFAULT_UI = {
    minimizeAtStartup: true,
    hideOnMinimize: true,
    hideOnClose: true,
    showDashboardTopBar: true,
    showDashboardTerminal: true,
    showDashboardNetworkOutput: true,
    compactDashboard: false,
    weatherCity: 'Amsterdam',
    autoSaveChat: true,
    showDevTools: false,
    showInAppNotifications: true
};

function mergeUi(incoming = {}) {
    return { ...DEFAULT_UI, ...(incoming || {}) };
}

function ToggleSetting({ id, label, description, checked, onChange }) {
    return (
        <label className="settingToggle" htmlFor={id}>
            <span className="settingToggleText">
                <strong>{label}</strong>
                {description ? <span>{description}</span> : null}
            </span>
            <input
                id={id}
                type="checkbox"
                checked={Boolean(checked)}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="toggleSwitch" aria-hidden="true" />
        </label>
    );
}

function WeatherCityField({ value, onChange }) {
    return (
        <label className="settingField">
            <span>
                <strong>Weather city</strong>
                <span>Used by the dashboard top bar. Leave it as a simple city name for best results.</span>
            </span>
            <input
                type="text"
                value={value}
                maxLength={64}
                onChange={(event) => onChange(event.target.value)}
                placeholder="Amsterdam"
            />
        </label>
    );
}

function sameUi(a = {}, b = {}) {
    return Object.keys(DEFAULT_UI).every((key) => a?.[key] === b?.[key]);
}

export default function Settings({ route, setRoute }) {
    const [ui, setUi] = useState(DEFAULT_UI);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [isDirty, setIsDirty] = useState(false);
    const [message, setMessage] = useState('');
    const loadedRef = useRef(false);
    const uiRef = useRef(DEFAULT_UI);
    const lastSavedUiRef = useRef(null);
    const saveTimerRef = useRef(null);

    useEffect(() => {
        let cancelled = false;

        async function loadSettings() {
            setLoading(true);
            setMessage('');

            try {
                const result = await invoke('settings:get');
                if (!cancelled) {
                    const loadedUi = mergeUi(result?.ui);
                    loadedRef.current = true;
                    uiRef.current = loadedUi;
                    lastSavedUiRef.current = loadedUi;
                    setUi(loadedUi);
                }
            } catch (err) {
                if (!cancelled) {
                    loadedRef.current = true;
                    uiRef.current = DEFAULT_UI;
                    lastSavedUiRef.current = DEFAULT_UI;
                    setUi(DEFAULT_UI);
                    setMessage(err?.message || 'Unable to load settings');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadSettings();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const unsubscribe = window.electronAPI?.on?.('settings-changed', (nextUi) => {
            if (!cancelled) {
                const nextSettings = mergeUi(nextUi);
                uiRef.current = nextSettings;
                lastSavedUiRef.current = nextSettings;
                loadedRef.current = true;
                setUi(nextSettings);
                setIsDirty(false);
                setMessage('Settings updated.');
            }
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        if (!loadedRef.current) return;
        if (sameUi(ui, lastSavedUiRef.current)) {
            setIsDirty(false);
            return;
        }

        setIsDirty(true);

        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
        }

        setMessage('Saving...');
        saveTimerRef.current = setTimeout(() => {
            saveSettings(false);
        }, 250);

        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        };
    }, [ui]);

    function updateSetting(key, value) {
        const next = { ...uiRef.current, [key]: value };
        uiRef.current = next;
        setUi(next);
        setIsDirty(true);
        setMessage('Saving...');
    }

    async function saveSettings(showMessage = true) {
        setSaving(true);
        setMessage('');

        try {
            const currentUi = uiRef.current;
            const result = await invoke('settings:update', currentUi);
            if (!result?.ok) throw new Error(result?.error || 'Unable to save settings');
            uiRef.current = mergeUi(result.ui);
            lastSavedUiRef.current = uiRef.current;
            setIsDirty(false);
            setMessage(showMessage
                ? 'Settings saved. Startup changes apply after restart; window behavior updates immediately.'
                : 'Saved to config.');
        } catch (err) {
            setMessage(err?.message || 'Unable to save settings');
        } finally {
            setSaving(false);
        }
    }

    function resetSettings() {
        const defaults = { ...DEFAULT_UI };
        uiRef.current = defaults;
        lastSavedUiRef.current = null;
        setUi(defaults);
        setIsDirty(true);
        setMessage('Defaults restored. Save to apply them.');
    }

    async function exportConfig() {
        setSaving(true);
        setMessage('');

        try {
            const result = await invoke('config:export');
            if (!result?.ok) {
                if (result?.canceled) return;
                throw new Error(result?.error || 'Unable to export config');
            }
            setMessage(`Config exported to: ${result.path}`);
        } catch (err) {
            setMessage(err?.message || 'Unable to export config');
        } finally {
            setSaving(false);
        }
    }

    // ==================== ENVIRONMENT CONFIGURATION ====================
    const [envStatus, setEnvStatus] = useState(null);
    const [envVariables, setEnvVariables] = useState([]);
    const [envLoading, setEnvLoading] = useState(false);
    const [envMessage, setEnvMessage] = useState('');
    const [revealedSecrets, setRevealedSecrets] = useState(new Set());
    const loadEnvStatus = useCallback(async () => {
        setEnvLoading(true);
        setEnvMessage('');
        try {
            const result = await invoke('env:status');
            if (result.ok) {
                setEnvStatus(result.status);
                setEnvVariables(result.variables);
            } else {
                setEnvMessage(result.error || 'Failed to load environment status');
            }
        } catch (err) {
            setEnvMessage(err.message || 'Failed to load environment status');
        } finally {
            setEnvLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEnvStatus();
    }, [loadEnvStatus]);

    const handleImportEnv = async () => {
        setEnvMessage('');
        try {
            const result = await invoke('env:import');
            if (result.ok) {
                setEnvStatus(result.status);
                setEnvVariables(result.variables);
                setEnvMessage(`Imported ${result.imported} environment variables.`);
            } else if (result.canceled) {
                // User cancelled, do nothing
            } else {
                setEnvMessage(result.error || 'Import failed');
            }
        } catch (err) {
            setEnvMessage(err.message || 'Import failed');
        }
    };

    const handleReloadEnv = async () => {
        setEnvMessage('');
        try {
            const result = await invoke('env:reload');
            if (result.ok) {
                setEnvStatus(result.status);
                setEnvVariables(result.variables);
                setEnvMessage('Environment reloaded.');
            } else {
                setEnvMessage(result.error || 'Reload failed');
            }
        } catch (err) {
            setEnvMessage(err.message || 'Reload failed');
        }
    };

    const handleValidateEnv = async () => {
        setEnvMessage('');
        try {
            const result = await invoke('env:validate');
            if (result.ok) {
                setEnvStatus(result.status);
                setEnvVariables(result.variables);
                if (result.status.ok) {
                    setEnvMessage('All required environment variables are configured.');
                } else {
                    const missing = result.status.missing.join(', ');
                    setEnvMessage(`Missing required variables: ${missing}`);
                }
            } else {
                setEnvMessage(result.error || 'Validation failed');
            }
        } catch (err) {
            setEnvMessage(err.message || 'Validation failed');
        }
    };

    const handleClearEnv = async () => {
        setEnvMessage('');
        try {
            const result = await invoke('env:clear');
            if (result.ok) {
                setEnvStatus(result.status);
                setEnvVariables(result.variables);
                setEnvMessage('Imported environment cleared. Using development/system sources.');
            } else {
                setEnvMessage(result.error || 'Clear failed');
            }
        } catch (err) {
            setEnvMessage(err.message || 'Clear failed');
        }
    };

    const toggleSecretReveal = (key) => {
        setRevealedSecrets(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const getSourceLabel = (source) => {
        switch (source) {
            case 'imported': return 'Imported .env file';
            case 'development': return 'Development (src/.env)';
            case 'system': return 'System environment variables';
            case 'none': return 'None — no configuration loaded';
            default: return source;
        }
    };

    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        };
    }, []);

    return (
        <PageShell
            title="Settings"
            route={route}
            setRoute={setRoute}
            showBack={true}
            leftChildren={(
                <>
                    <div className="settingsActions settingsLeftActions">
                        <button type="button" onClick={resetSettings} disabled={saving || loading}>
                            Reset defaults
                        </button>
                        <button type="button" onClick={saveSettings} disabled={saving || loading}>
                            {saving ? 'Saving...' : isDirty ? 'Save changes' : 'Save settings'}
                        </button>
                        <button type="button" onClick={exportConfig} disabled={saving || loading}>
                            Export config
                        </button>
                    </div>

                    {message ? <div className="settingsMessage settingsLeftMessage">{message}</div> : null}
                </>
            )}
        >
            <div className="settingsPage">
                <section className="settingsIntro">
                    <div>
                        <h2>Application Settings</h2>
                        <p>
                            Toggles for startup behavior, dashboard widgets, and quick quality-of-life preferences.
                        </p>
                    </div>
                    {loading ? <span className="settingsHint">Loading settings...</span> : null}
                </section>

                <div className="settingsGrid">
                    <section className="settingsCard">
                        <h3>Startup & Window</h3>
                        <ToggleSetting
                            id="minimizeAtStartup"
                            label="Minimize at startup"
                            description="Start hidden in the tray instead of showing the window immediately."
                            checked={ui.minimizeAtStartup}
                            onChange={(value) => updateSetting('minimizeAtStartup', value)}
                        />
                        <ToggleSetting
                            id="hideOnMinimize"
                            label="Hide when minimized"
                            description="Keep the current hardcoded behavior: minimizing sends the app back to tray."
                            checked={ui.hideOnMinimize}
                            onChange={(value) => updateSetting('hideOnMinimize', value)}
                        />
                        <ToggleSetting
                            id="hideOnClose"
                            label="Hide on window close"
                            description="Close keeps the app running in the tray. Disable to let close quit the app."
                            checked={ui.hideOnClose}
                            onChange={(value) => updateSetting('hideOnClose', value)}
                        />
                    </section>

                    <section className="settingsCard">
                        <h3>Dashboard Widgets</h3>
                        <ToggleSetting
                            id="showDashboardTopBar"
                            label="Show top info bar"
                            description="Show date, time, timezone, and weather at the top of the dashboard."
                            checked={ui.showDashboardTopBar}
                            onChange={(value) => updateSetting('showDashboardTopBar', value)}
                        />
                        <ToggleSetting
                            id="showDashboardTerminal"
                            label="Show terminal panel"
                            description="Keep script/terminal output visible on the dashboard."
                            checked={ui.showDashboardTerminal}
                            onChange={(value) => updateSetting('showDashboardTerminal', value)}
                        />
                        <ToggleSetting
                            id="showDashboardNetworkOutput"
                            label="Show network output panel"
                            description="Keep live tcpdump/network output visible on the dashboard."
                            checked={ui.showDashboardNetworkOutput}
                            onChange={(value) => updateSetting('showDashboardNetworkOutput', value)}
                        />
                        <ToggleSetting
                            id="compactDashboard"
                            label="Compact dashboard panels"
                            description="Use tighter borders and spacing for the dashboard output panels."
                            checked={ui.compactDashboard}
                            onChange={(value) => updateSetting('compactDashboard', value)}
                        />
                    </section>

                    <section className="settingsCard">
                        <h3>Weather</h3>
                        <WeatherCityField
                            value={ui.weatherCity}
                            onChange={(value) => updateSetting('weatherCity', value)}
                        />
                    </section>

                    <section className="settingsCard">
                        <h3>AI Chat</h3>
                        <ToggleSetting
                            id="autoSaveChat"
                            label="Auto-save chat to database"
                            description="Automatically save AI chat messages to the cream database (src/database/cream/)."
                            checked={ui.autoSaveChat}
                            onChange={(value) => updateSetting('autoSaveChat', value)}
                        />
                    </section>

                    <section className="settingsCard">
                        <h3>Developer</h3>
                        <ToggleSetting
                            id="showDevTools"
                            label="Show DevTools"
                            description="Open the Electron DevTools panel on startup and allow toggling it from the UI."
                            checked={ui.showDevTools}
                            onChange={async (value) => {
                                updateSetting('showDevTools', value);
                                try {
                                    await invoke('devtools:toggle', value);
                                } catch (err) {
                                    console.error('Failed to toggle devtools:', err);
                                }
                            }}
                        />
                    </section>

                    <section className="settingsCard">
                        <h3>Notifications</h3>
                        <ToggleSetting
                            id="showInAppNotifications"
                            label="Show in-app notifications"
                            description="Display task reminder and due-date toasts inside the Tasks page. OS-level notifications are unaffected."
                            checked={ui.showInAppNotifications}
                            onChange={(value) => updateSetting('showInAppNotifications', value)}
                        />
                    </section>
                </div>

                {/* ==================== ENVIRONMENT CONFIGURATION ==================== */}
                <section className="settingsEnvironmentPanel">
                    {/* Header Card */}
                    <div className="settingsEnvLayout">
                        <div className="settingsEnvHeader">
                            <h2>Environment Configuration</h2>
                            <p className="settingsEnvHeaderDesc">
                                Manage API keys and secrets for social media integrations and external services.
                            </p>
                            {envStatus && (
                                <div className="settingsEnvHeaderMeta">
                                    <span className="settingsEnvMetaLabel">Source: </span>
                                    <span className="settingsEnvMetaValue">{getSourceLabel(envStatus.source)}</span>
                                    <span className="settingsEnvMetaSep">|</span>
                                    <span className="settingsEnvMetaLabel">Configured: </span>
                                    <span className="settingsEnvMetaCount">{envStatus.available}/{envStatus.total}</span>
                                    {envStatus.missingCount > 0 && (
                                        <>
                                            <span className="settingsEnvMetaSep">|</span>
                                            <span className="settingsEnvMetaLabel">Missing: </span>
                                            <span className="settingsEnvMetaMissing">{envStatus.missingCount}</span>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Action Buttons */}
                        <div className="settingsEnvActions">
                            <button
                                type="button"
                                className="chButton chButtonPrimary"
                                onClick={handleImportEnv}
                                disabled={envLoading}
                            >
                                Import .env
                            </button>
                            <button
                                type="button"
                                className="chButton"
                                onClick={handleReloadEnv}
                                disabled={envLoading}
                            >
                                Reload
                            </button>
                            <button
                                type="button"
                                className="chButton"
                                onClick={handleValidateEnv}
                                disabled={envLoading}
                            >
                                Validate
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonDanger"
                                onClick={handleClearEnv}
                                disabled={envLoading}
                            >
                                Clear Imported
                            </button>
                        </div>

                        {/* Status Message */}
                        {envMessage ? (
                            <div className="settingsEnvStatusMessage">
                                {envMessage}
                            </div>
                        ) : null}

                        {/* Provider Cards Grid */}
                        {envStatus && envStatus.providers && envStatus.providers.length > 0 && (
                            <div className="settingsEnvProviders">
                                {envStatus.providers.map((provider) => (
                                    <div key={provider.provider} className="settingsEnvProviderCard">
                                        <div className="settingsEnvProviderCardHeader">
                                            <span className={
                                                provider.configured
                                                    ? 'settingsEnvProviderDot settingsEnvProviderDot--active'
                                                    : 'settingsEnvProviderDot settingsEnvProviderDot--inactive'
                                            } />
                                            <h4>{provider.provider}</h4>
                                        </div>
                                        {provider.configured ? (
                                            <p className="settingsEnvProviderStatus settingsEnvProviderStatus--ok">Configured</p>
                                        ) : (
                                            <div>
                                                <p className="settingsEnvProviderStatus settingsEnvProviderStatus--missing">
                                                    Missing required variables:
                                                </p>
                                                <ul className="settingsEnvProviderMissingList">
                                                    {provider.missing.map((key) => (
                                                        <li key={key}>{key}</li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Variables Card */}
                        {envVariables.length > 0 && (
                            <div className="settingsEnvVariablesCard">
                                <h3>All Variables</h3>
                                <div className="settingsEnvVariableList">
                                    {envVariables.map((variable) => (
                                        <div key={variable.key} className="settingsEnvVariableRow">
                                            <div className="settingsEnvVariableInfo">
                                                <span className={
                                                    variable.present
                                                        ? 'settingsEnvVarDot settingsEnvVarDot--present'
                                                        : 'settingsEnvVarDot settingsEnvVarDot--missing'
                                                } />
                                                <div className="settingsEnvVarDetails">
                                                    <span className={
                                                        variable.present
                                                            ? 'settingsEnvVarKey settingsEnvVarKey--present'
                                                            : 'settingsEnvVarKey settingsEnvVarKey--missing'
                                                    }>
                                                        {variable.key}
                                                    </span>
                                                    <span className="settingsEnvVarProviderName">
                                                        ({variable.provider})
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="settingsEnvVariableActions">
                                                {variable.type === 'secret' && variable.present ? (
                                                    <button
                                                        type="button"
                                                        className="settingsEnvRevealBtn"
                                                        onClick={() => toggleSecretReveal(variable.key)}
                                                    >
                                                        {revealedSecrets.has(variable.key) ? 'Hide' : 'Reveal'}
                                                    </button>
                                                ) : null}
                                                <span className={
                                                    variable.present
                                                        ? 'settingsEnvVarStatus settingsEnvVarStatus--present'
                                                        : 'settingsEnvVarStatus settingsEnvVarStatus--missing'
                                                }>
                                                    {variable.present
                                                        ? (variable.type === 'secret' && !revealedSecrets.has(variable.key)
                                                            ? '********'
                                                            : '✓ Set')
                                                        : '— Missing'}
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </PageShell>
    );
}
