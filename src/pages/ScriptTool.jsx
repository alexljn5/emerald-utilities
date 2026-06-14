import { useEffect, useMemo, useState } from 'react';
import PageShell from './PageShell.jsx';
import { scriptManager } from '../core/scriptManager.js';
import { invoke } from '../js/electronApi.js';
import { useTerminalLog } from '../js/terminalHooks.js';
import '../css/script_tool.css';

function TerminalLines({ terminalLog, terminalHidden, terminalRef }) {
    const lines = useMemo(() => terminalLog.slice(-500), [terminalLog]);

    return (
        <div id="terminalOutput" className={terminalHidden ? 'terminalHidden' : ''} ref={terminalRef}>
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
    );
}

export default function ScriptTool({ route, setRoute }) {
    const { terminalLog, appendTerminalLog, terminalRef } = useTerminalLog();
    const [files, setFiles] = useState([]);
    const [configScripts, setConfigScripts] = useState([]);
    const [selectedFile, setSelectedFile] = useState(null);
    const [terminalHidden, setTerminalHidden] = useState(false);
    const [scriptContent, setScriptContent] = useState('');
    const [autoRun, setAutoRun] = useState(false);
    const [cronEnabled, setCronEnabled] = useState(false);
    const [cronInterval, setCronInterval] = useState('');
    const [argsInput, setArgsInput] = useState('');
    const [ahkPath, setAhkPath] = useState('');

    const selectedConfig = useMemo(() => {
        return configScripts.find((script) => script.file === selectedFile) || {
            file: selectedFile,
            displayName: selectedFile ? `Run ${selectedFile}` : '',
            autoRun: false,
            cronEnabled: false,
            cronInterval: 0
        };
    }, [configScripts, selectedFile]);

    const isAhkFile = Boolean(selectedFile?.toLowerCase().endsWith('.ahk'));
    const isRunning = selectedFile ? scriptManager.isScriptRunning(selectedFile) : false;
    const isCronRunning = selectedFile ? scriptManager.isCronRunning(selectedFile) : false;

    useEffect(() => {
        scriptManager.bindLogger(appendTerminalLog);
        scriptManager.bindRenderer((nextFiles, nextConfigScripts) => {
            setFiles([...nextFiles]);
            setConfigScripts([...nextConfigScripts]);
        });
        scriptManager.bindContentChange(setScriptContent);
        scriptManager.init({ bindUI: true, skipAutoRun: true });
        scriptManager.replayMainProcessLogToTerminal(500);

        invoke('get-ahk-path')
            .then((value) => setAhkPath(value || ''))
            .catch(() => setAhkPath(''));

        return () => {
            scriptManager.unbindLogger();
            scriptManager.bindRenderer(() => { });
            scriptManager.bindContentChange(null);
        };
    }, []);

    function selectScript(file) {
        const cfg = configScripts.find((script) => script.file === file) || {};
        setSelectedFile(file);
        setAutoRun(!!cfg.autoRun);
        setCronEnabled(!!cfg.cronEnabled);
        setCronInterval(cfg.cronInterval || '');
        scriptManager.viewScript(file);
    }

    async function handleAutoRunChange(event) {
        if (!selectedFile) return;

        const nextAutoRun = event.target.checked;
        setAutoRun(nextAutoRun);
        await scriptManager.updateConfig(selectedFile, { autoRun: nextAutoRun });
    }

    async function handleCronEnabledChange(event) {
        if (!selectedFile) return;

        const nextCronEnabled = event.target.checked;
        const intervalMs = parseInt(cronInterval, 10) || 0;
        setCronEnabled(nextCronEnabled);
        await scriptManager.saveCronConfig(selectedFile, intervalMs, nextCronEnabled);
        scriptManager._log(`Cron auto-start ${nextCronEnabled ? 'enabled' : 'disabled'} for ${selectedFile}`);
    }

    async function handleCronToggle() {
        if (!selectedFile) return;

        const intervalMs = parseInt(cronInterval, 10);
        if (!intervalMs || intervalMs < 1000) {
            scriptManager._log('Cron interval must be at least 1000ms (1 second)');
            return;
        }

        if (scriptManager.isCronRunning(selectedFile)) {
            await scriptManager.stopCronScript(selectedFile);
            await scriptManager.saveCronConfig(selectedFile, intervalMs, false);
            setCronEnabled(false);
        } else {
            await scriptManager.startCronScript(selectedFile, intervalMs);
            await scriptManager.saveCronConfig(selectedFile, intervalMs, true);
            setCronEnabled(true);
        }
    }

    async function handleAhkBrowse() {
        const result = await invoke('select-file', {
            title: 'Select AutoHotkey.exe',
            filters: [{ name: 'Executable', extensions: ['exe'] }],
            properties: ['openFile']
        });

        if (result && !result.canceled && result.filePaths.length > 0) {
            const nextAhkPath = result.filePaths[0];
            setAhkPath(nextAhkPath);
            await invoke('set-ahk-path', nextAhkPath);
            scriptManager._log(`[AHK] Path set to: ${nextAhkPath}`);
        }
    }

    async function handleAhkReset() {
        setAhkPath('');
        await invoke('set-ahk-path', null);
        scriptManager._log('[AHK] Path reset to auto-detect');
    }

    async function handleAhkChange(event) {
        const nextAhkPath = event.target.value.trim();
        setAhkPath(nextAhkPath);
        await invoke('set-ahk-path', nextAhkPath || null);
        scriptManager._log(`[AHK] Path set to: ${nextAhkPath || 'auto-detect'}`);
    }

    return (
        <PageShell title="Script Tool" route={route} setRoute={setRoute} leftChildren={
            <>
                <button type="button" onClick={() => scriptManager.chooseCustomScriptFolder()}>Choose Custom Scripts Folder</button>
                <button type="button" onClick={() => scriptManager.loadScripts()}>Load Scripts</button>

                <h3>Scripts:</h3>
                <div id="scriptList">
                    {files.map((file) => {
                        const cfg = configScripts.find((script) => script.file === file) || {
                            file,
                            displayName: `Run ${file}`,
                            autoRun: false
                        };
                        const active = file === selectedFile;
                        const running = scriptManager.isScriptRunning(file);
                        const cronRunning = scriptManager.isCronRunning(file);
                        const isAutoRun = !!cfg.autoRun;
                        const isCronEnabled = !!cfg.cronEnabled;
                        let badgeText = '';
                        let badgeClass = 'scriptBadge';

                        if (cronRunning) {
                            badgeText = isAutoRun ? 'Auto+Cron' : 'Cron';
                            badgeClass += ' cronBadge';
                        } else if (running) {
                            badgeText = isAutoRun ? 'Auto+Running' : 'Running';
                        } else if (isCronEnabled) {
                            badgeText = 'Auto+Cron';
                            badgeClass += ' cronBadge';
                        } else if (isAutoRun) {
                            badgeText = 'Auto';
                        }

                        return (
                            <div
                                key={file}
                                className={`scriptListItem${active ? ' active' : ''}`}
                                onClick={() => selectScript(file)}
                            >
                                <span className="scriptName">{cfg.displayName || file}</span>
                                {badgeText ? <span className={badgeClass}>{badgeText}</span> : null}
                            </div>
                        );
                    })}
                </div>
            </>
        }>
            <button
                id="terminalToggleButton"
                className={`terminalToggle${terminalHidden ? ' terminalHidden' : ''}`}
                type="button"
                title="Toggle Terminal"
                onClick={() => setTerminalHidden((hidden) => !hidden)}
            >
                {terminalHidden ? 'Show Terminal' : 'Terminal'}
            </button>

            <div id="detailPanel" className={`detailPanel${selectedFile ? '' : ' hidden'}`}>
                <h2 id="detailScriptName">{selectedFile || 'Select a script'}</h2>

                <div className="detailPanelContent">
                    <div className="detailActions">
                        <button id="runButton" type="button" onClick={() => selectedFile && scriptManager.runScript(selectedFile)}>
                            {isRunning ? `⏹ Stop ${selectedFile}` : `▶ Run ${selectedFile}`}
                        </button>
                        <button id="runStartupButton" type="button" onClick={() => selectedFile && scriptManager.runScript(selectedFile)}>Run Startup</button>
                        <button id="viewButton" type="button" onClick={() => selectedFile && scriptManager.viewScript(selectedFile)}>View</button>
                    </div>

                    <div className="detailRow">
                        <label>
                            <input
                                id="autoRunToggle"
                                type="checkbox"
                                checked={autoRun}
                                onChange={handleAutoRunChange}
                                disabled={!selectedFile}
                            />{' '}
                            Auto-run on startup
                        </label>
                    </div>

                    <div className="detailRow">
                        <label>
                            <input
                                id="cronEnabledToggle"
                                type="checkbox"
                                checked={cronEnabled}
                                onChange={handleCronEnabledChange}
                                disabled={!selectedFile}
                            />{' '}
                            Auto-start cron on startup
                        </label>
                    </div>

                    <div className="detailRow">
                        <label>Cron / Interval (ms):</label>
                        <div className="inlineControls">
                            <input
                                id="cronInput"
                                type="number"
                                placeholder="e.g. 5000 for 5 seconds"
                                min="1000"
                                step="1000"
                                value={cronInterval}
                                onChange={(event) => setCronInterval(event.target.value)}
                                disabled={!selectedFile || isCronRunning}
                            />
                            <button
                                id="cronToggleButton"
                                className={isCronRunning ? 'cronActive' : ''}
                                type="button"
                                onClick={handleCronToggle}
                                disabled={!selectedFile || isCronRunning}
                            >
                                {isCronRunning ? '⏹ Stop Cron' : '▶ Start Cron'}
                            </button>
                        </div>
                    </div>

                    {isAhkFile ? (
                        <div className="detailRow ahkPathRow">
                            <label>AutoHotkey Path:</label>
                            <input
                                id="ahkPathInput"
                                type="text"
                                placeholder="e.g. C:\Program Files\AutoHotkey\AutoHotkey.exe"
                                value={ahkPath}
                                onChange={handleAhkChange}
                            />
                            <button id="ahkBrowseButton" type="button" onClick={handleAhkBrowse}>Browse</button>
                            <button id="ahkResetButton" type="button" onClick={handleAhkReset}>Reset</button>
                        </div>
                    ) : null}

                    <div className="detailRow">
                        <label>Arguments:</label>
                        <input
                            id="argsInput"
                            type="text"
                            placeholder="Enter arguments"
                            value={argsInput}
                            onChange={(event) => setArgsInput(event.target.value)}
                        />
                    </div>

                    <div className="detailRow">
                        <label>Script Content:</label>
                        <textarea
                            id="scriptContent"
                            value={scriptContent}
                            onChange={(event) => setScriptContent(event.target.value)}
                        />
                    </div>
                </div>

                <div className="detailPanelActions">
                    <button id="saveScriptButton" type="button" onClick={() => scriptManager.saveScript()}>Save Script</button>
                </div>
            </div>

            <TerminalLines terminalLog={terminalLog} terminalHidden={terminalHidden} terminalRef={terminalRef} />
        </PageShell>
    );
}
