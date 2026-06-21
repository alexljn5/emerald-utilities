import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../js/electronApi.js';
import '../css/settings.css';

const DEFAULT_UI = {
    minimizeAtStartup: true,
    hideOnMinimize: true,
    hideOnClose: true,
    showDashboardTopBar: true,
    showDashboardTerminal: true,
    showDashboardNetworkOutput: true,
    compactDashboard: false,
    weatherCity: 'Amsterdam'
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

    useEffect(() => {
        return () => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
            }
        };
    }, []);

    return (
        <PageShell title="Settings" route={route} setRoute={setRoute} showBack={true}>
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
                </div>

                <div className="settingsActions">
                    <button type="button" onClick={resetSettings} disabled={saving || loading}>
                        Reset defaults
                    </button>
                    <button type="button" onClick={saveSettings} disabled={saving || loading}>
                        {saving ? 'Saving...' : isDirty ? 'Save changes' : 'Save settings'}
                    </button>
                </div>

                {message ? <div className="settingsMessage">{message}</div> : null}
            </div>
        </PageShell>
    );
}
