import { useEffect, useMemo, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { scriptManager } from '../core/scriptManager.js';
import { networkManager } from '../core/networkManager.js';
import { useTerminalLog } from '../js/terminalHooks.js';
import { invoke } from '../js/electronApi.js';
import sigil from '../../img/backgrounds/sigil_1.png';
import neutralMascot from '../../img/mascot/dashboardMascotNeutral.png';
import happyMascot from '../../img/mascot/dashboardMascotHappy.png';
import nervousMascot from '../../img/mascot/dashboardMascotNervous.png';
import angryMascot from '../../img/mascot/dashboardMascotAngry.png';
import blushingMascot from '../../img/mascot/dashboardMascotBlushing.png';
import manicMascot from '../../img/mascot/dashboardMascotManic.png';
import '../css/index.css';

const moods = {
    neutral: neutralMascot,
    happy: happyMascot,
    nervous: nervousMascot,
    angry: angryMascot,
    blushing: blushingMascot,
    manic: manicMascot
};

const DEFAULT_DASHBOARD_UI = {
    showDashboardTopBar: true,
    showDashboardTerminal: true,
    showDashboardNetworkOutput: true,
    compactDashboard: false,
    weatherCity: 'Amsterdam'
};

function normalizeWeatherCity(city) {
    const clean = String(city || DEFAULT_DASHBOARD_UI.weatherCity).trim();
    return clean || DEFAULT_DASHBOARD_UI.weatherCity;
}

function formatClock(date) {
    return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function formatDateLabel(date) {
    return date.toLocaleDateString([], {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function DashboardTopBar({ ui }) {
    const [now, setNow] = useState(new Date());
    const [weather, setWeather] = useState({ loading: false, error: '', data: null });
    const weatherCity = normalizeWeatherCity(ui?.weatherCity);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (!ui?.showDashboardTopBar) return;

        let cancelled = false;

        async function loadWeather() {
            setWeather({ loading: true, error: '', data: null });

            try {
                const response = await fetch(`https://wttr.in/${encodeURIComponent(weatherCity)}?format=j1`);
                if (!response.ok) throw new Error(`Weather service returned ${response.status}`);

                const json = await response.json();
                const current = json.current_condition?.[0];
                if (!current) throw new Error('Weather data unavailable');

                if (cancelled) return;

                setWeather({
                    loading: false,
                    error: '',
                    data: {
                        tempC: current.temp_C,
                        feelsLikeC: current.FeelsLikeC,
                        description: current.weatherDesc?.[0]?.value || 'Unknown',
                        humidity: current.humidity,
                        windKmph: current.windspeedKmph
                    }
                });
            } catch (err) {
                if (cancelled) return;
                setWeather({ loading: false, error: err?.message || 'Unable to load weather', data: null });
            }
        }

        loadWeather();

        return () => {
            cancelled = true;
        };
    }, [ui?.showDashboardTopBar, weatherCity]);

    return (
        <div className="dashboardTopBar">
            <div className="dashboardInfoCluster">
                <span className="dashboardInfoPill">{formatDateLabel(now)}</span>
                <span className="dashboardInfoPill dashboardClock">{formatClock(now)}</span>
                <span className="dashboardInfoPill">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
            </div>

            <div className="dashboardWeather">
                <span className="dashboardWeatherCity">{weatherCity}</span>
                {weather.loading ? (
                    <span className="dashboardWeatherText">Loading weather...</span>
                ) : weather.error ? (
                    <span className="dashboardWeatherText dashboardWeatherError">{weather.error}</span>
                ) : weather.data ? (
                    <span className="dashboardWeatherText">
                        {weather.data.description}, {weather.data.tempC}°C
                        {weather.data.feelsLikeC ? ` · feels ${weather.data.feelsLikeC}°C` : ''}
                        {weather.data.humidity ? ` · ${weather.data.humidity}% humidity` : ''}
                        {weather.data.windKmph ? ` · wind ${weather.data.windKmph} km/h` : ''}
                    </span>
                ) : (
                    <span className="dashboardWeatherText">Weather unavailable</span>
                )}
            </div>
        </div>
    );
}

function TerminalLines({ terminalLog, terminalRef, ui }) {
    const lines = useMemo(() => terminalLog.slice(-500), [terminalLog]);

    if (!ui?.showDashboardTerminal) {
        return null;
    }

    return (
        <section className={`dashboardPanel terminalPanel${ui.compactDashboard ? ' compactPanel' : ''}`}>
            <div className="dashboardPanelHeader">
                <h3>Terminal</h3>
                <span>{lines.length} recent line{lines.length === 1 ? '' : 's'}</span>
            </div>
            <div id="terminalOutput" className="dashboardTerminal dashboardPanelScroll" ref={terminalRef}>
                {lines.length === 0 ? (
                    <div className="logPlaceholder">No terminal output yet.</div>
                ) : (
                    lines.map((entry, index) => (
                        <div className="logLine" key={`${entry.id ?? index}-${index}`}>
                            {entry.message}
                        </div>
                    ))
                )}
            </div>
        </section>
    );
}

function DashboardNetworkPanel({ ui }) {
    const [state, setState] = useState({
        isCapturing: networkManager.state.isCapturing,
        logs: [...(networkManager.state.logs || [])],
        status: networkManager.state.status
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const logRef = useRef(null);
    const lines = useMemo(() => state.logs.slice(-120), [state.logs]);

    useEffect(() => {
        let cancelled = false;

        networkManager.syncCaptureStatus().catch(() => {
            if (!cancelled) setError('Unable to sync capture status');
        });

        const unsubscribe = networkManager.onStateChange((next) => {
            if (cancelled) return;

            setState({
                isCapturing: next.isCapturing,
                logs: [...(next.logs || [])],
                status: next.status
            });
            setError('');
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [state.logs, logRef]);

    async function toggleCapture() {
        if (busy) return;
        setBusy(true);
        setError('');

        try {
            if (state.isCapturing) {
                await networkManager.stopCapture();
            } else {
                const started = await networkManager.startCapture({ interface: 'any' });
                if (!started) setError('Unable to start network capture');
            }
        } catch (err) {
            setError(err?.message || 'Unable to toggle network capture');
        } finally {
            setBusy(false);
        }
    }

    function clearLogs() {
        networkManager.clearLogs();
    }

    return (
        <section className={`dashboardPanel networkPanel${ui.compactDashboard ? ' compactPanel' : ''}`}>
            <div className="dashboardPanelHeader">
                <h3>Network Output</h3>
                <div className="dashboardPanelActions">
                    <button type="button" disabled={busy} onClick={toggleCapture}>
                        {state.isCapturing ? '⏹ Stop' : '▶ Start'}
                    </button>
                    <button type="button" onClick={clearLogs}>Clear</button>
                </div>
            </div>

            <div className="dashboardNetworkStatus">
                {state.status || (state.isCapturing ? 'Capturing...' : 'Idle')}
            </div>
            {error ? <div className="dashboardNetworkError">{error}</div> : null}

            <div className="dashboardNetworkLog dashboardPanelScroll" ref={logRef}>
                {lines.length === 0 ? (
                    <div className="logPlaceholder">
                        {state.isCapturing ? 'Capturing packets...' : 'No network output yet. Start a capture to stream tcpdump lines here.'}
                    </div>
                ) : (
                    lines.map((line, index) => <div className="logLine" key={`${line}-${index}`}>{line}</div>)
                )}
            </div>
        </section>
    );
}

export default function Dashboard({ route, setRoute }) {
    const { terminalLog, appendTerminalLog, terminalRef } = useTerminalLog();
    const [dashboardUi, setDashboardUi] = useState(null);
    const [mascotMood, setMascotMood] = useState('neutral');
    const ui = { ...DEFAULT_DASHBOARD_UI, ...(dashboardUi || {}) };
    const showTerminalPanel = Boolean(ui.showDashboardTerminal);
    const showNetworkPanel = Boolean(ui.showDashboardNetworkOutput);
    const panelsClass = showTerminalPanel && showNetworkPanel
        ? 'dashboardPanels twoPanels'
        : showTerminalPanel
            ? 'dashboardPanels terminalOnly'
            : showNetworkPanel
                ? 'dashboardPanels networkOnly'
                : 'dashboardPanels emptyPanels';

    useEffect(() => {
        let cancelled = false;

        async function loadDashboardSettings() {
            try {
                const result = await invoke('settings:get');
                if (!cancelled && result?.ok) {
                    setDashboardUi(result.ui || {});
                }
            } catch {
                if (!cancelled) setDashboardUi(DEFAULT_DASHBOARD_UI);
            }
        }

        loadDashboardSettings();

        const unsubscribe = window.electronAPI?.on?.('settings-changed', (nextUi) => {
            if (!cancelled) setDashboardUi(nextUi || {});
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        scriptManager.bindLogger(appendTerminalLog);
        scriptManager.init({ bindUI: false, skipAutoRun: false });
        scriptManager.replayMainProcessLogToTerminal(500);

        return () => {
            scriptManager.unbindLogger();
        };
    }, []);

    useEffect(() => {
        const count = terminalLog.length;
        let nextMood = 'neutral';

        if (count >= 25) {
            nextMood = 'manic';
        } else if (count >= 10) {
            nextMood = 'nervous';
        } else if (count >= 1) {
            nextMood = 'happy';
        }

        setMascotMood(nextMood);

        const calmTimer = setTimeout(() => {
            setMascotMood('neutral');
        }, 3000);

        return () => clearTimeout(calmTimer);
    }, [terminalLog]);

    return (
        <PageShell title="Emerald Utilities" route={route} setRoute={setRoute} showBack={false} leftChildren={
            <div className="navBox">
                <h2>Navigation</h2>
                <div className="navButtons">
                    <button className="nav-btn full" type="button" onClick={() => setRoute('scriptTool')}>Script Tool</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('networkMonitoring')}>Network Monitor</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('settings')}>⚙ Settings</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('modUpdater')}>Mod Updater</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('ai')}>AI</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('about')}>ⓘ About</button>
                </div>
            </div>
        }>
            <div className="backGroundSigil" aria-hidden="true">
                <img id="backGroundSigil_1" src={sigil} alt="" />
            </div>

            <div className="dashboardContent">
                {ui.showDashboardTopBar ? <DashboardTopBar ui={ui} /> : null}
                <div className={panelsClass}>
                    {showTerminalPanel ? <TerminalLines terminalLog={terminalLog} terminalRef={terminalRef} ui={ui} /> : null}
                    {showNetworkPanel ? <DashboardNetworkPanel ui={ui} /> : null}
                </div>
            </div>

            <div id="dashboardMascotImage">
                <img id="dashboardMascot" src={moods[mascotMood]} alt="Dashboard mascot" />
            </div>
        </PageShell>
    );
}
