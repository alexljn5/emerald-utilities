import { useEffect, useMemo, useState } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../js/electronApi.js';
import '../css/mod-updater.css';

const STORAGE_KEYS = {
    modsFolder: 'modUpdater.modsFolder',
    autoDetectMCVersion: 'modUpdater.autoDetectMCVersion',
    includeUnstable: 'modUpdater.includeUnstable',
    overwrite: 'modUpdater.overwrite',
    backup: 'modUpdater.backup',
    deleteOld: 'modUpdater.deleteOld',
    copyNonUpdatable: 'modUpdater.copyNonUpdatable'
};

function isSelectableVersion(version) {
    return version && version.type !== 'separator' && !version.disabled && version.id;
}

function readStoredBool(key, fallback) {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored === 'true';
}

function storeBool(key, value) {
    localStorage.setItem(key, value ? 'true' : 'false');
}

function getStatusLabel(status, hasUpdate) {
    if (status === 'found' && hasUpdate) return 'Update available';
    if (status === 'found') return 'Up to date';
    if (status === 'not_found') return 'Not found';
    if (status === 'no_compatible') return 'No compatible version';
    if (status === 'error') return 'Error';
    if (status === 'downloaded') return 'Downloaded';
    if (status === 'up-to-date') return 'Up to date';
    return status || 'Unknown';
}

function getStatusClass(mod) {
    if (mod.status === 'error') return 'modCardError';
    if (mod.status === 'not_found') return 'modCardWarning';
    if (mod.status === 'no_compatible') return 'modCardWarning';
    if (mod.status === 'downloaded') return 'modCardSuccess';
    if (mod.status === 'found' && mod.hasUpdate) return 'modCardUpdate';
    return 'modCardIdle';
}

function ModCard({ mod, selected, onToggle }) {
    const selectable = mod.status === 'found' && mod.hasUpdate;
    const statusClass = getStatusClass(mod);
    const latestLine = mod.latestVersion ? `${mod.currentVersion} → ${mod.latestVersion}` : mod.currentVersion;

    return (
        <article className={`modCard ${statusClass}`}>
            <div className="modCardMain">
                <div className="modCardTitleRow">
                    <h4>{mod.id}</h4>
                    <span className={`modBadge ${statusClass}`}>{getStatusLabel(mod.status, mod.hasUpdate)}</span>
                </div>

                <div className="modMetaGrid">
                    <div>
                        <span>Project</span>
                        <strong>{mod.projectName || 'Unknown'}</strong>
                    </div>
                    <div>
                        <span>Version</span>
                        <strong>{latestLine}</strong>
                    </div>
                    <div>
                        <span>Detected MC</span>
                        <strong>{mod.detectedMCVersion || mod.targetVersion || '—'}</strong>
                    </div>
                    <div>
                        <span>Target</span>
                        <strong>{mod.targetVersion || '—'}</strong>
                    </div>
                    <div>
                        <span>File</span>
                        <strong title={mod.file}>{mod.file || '—'}</strong>
                    </div>
                </div>

                {mod.error ? <p className="modError">{mod.error}</p> : null}
            </div>

            {selectable ? (
                <label className="modSelect">
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => onToggle(mod.id, event.target.checked)}
                    />
                    <span>Select</span>
                </label>
            ) : null}
        </article>
    );
}

export default function ModUpdater({ route, setRoute }) {
    const [modsFolder, setModsFolder] = useState(() => localStorage.getItem(STORAGE_KEYS.modsFolder) || '');
    const [versions, setVersions] = useState([]);
    const [targetVersion, setTargetVersion] = useState('');
    const [autoDetectMCVersion, setAutoDetectMCVersion] = useState(() => readStoredBool(STORAGE_KEYS.autoDetectMCVersion, true));
    const [detectedMCVersion, setDetectedMCVersion] = useState('');
    const [detectedMCVersionConfidence, setDetectedMCVersionConfidence] = useState(0);
    const [includeUnstable, setIncludeUnstable] = useState(() => readStoredBool(STORAGE_KEYS.includeUnstable, true));
    const [overwrite, setOverwrite] = useState(() => readStoredBool(STORAGE_KEYS.overwrite, false));
    const [backup, setBackup] = useState(() => readStoredBool(STORAGE_KEYS.backup, true));
    const [deleteOld, setDeleteOld] = useState(() => readStoredBool(STORAGE_KEYS.deleteOld, true));
    const [copyNonUpdatable, setCopyNonUpdatable] = useState(() => readStoredBool(STORAGE_KEYS.copyNonUpdatable, true));
    const [mods, setMods] = useState([]);
    const [selectedModIds, setSelectedModIds] = useState(new Set());
    const [busy, setBusy] = useState(false);
    const [versionsLoading, setVersionsLoading] = useState(true);
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');

    const selectableMods = useMemo(() => mods.filter((mod) => mod.status === 'found' && mod.hasUpdate), [mods]);
    const selectedMods = useMemo(() => mods.filter((mod) => selectedModIds.has(mod.id)), [mods, selectedModIds]);
    const hasSelectedMods = selectedMods.length > 0;

    useEffect(() => {
        async function loadDefaults() {
            try {
                const defaultFolderResult = await invoke('mod-updater:get-default-folder');
                if (defaultFolderResult?.path && !modsFolder) {
                    setModsFolder(defaultFolderResult.path);
                    await analyzeFolder(defaultFolderResult.path);
                }
            } catch (err) {
                console.warn('[Mod Updater] Failed to load default folder:', err);
            }
        }

        loadDefaults();
    }, []);

    useEffect(() => {
        async function loadVersions() {
            setVersionsLoading(true);
            setError('');

            try {
                const result = await invoke('mod-updater:get-minecraft-versions');
                if (!result?.ok) {
                    throw new Error(result?.error || 'Unable to load Minecraft versions');
                }

                const fetchedVersions = result.versions || [];
                const selectableVersions = fetchedVersions.filter(isSelectableVersion);
                const latestMinecraft = selectableVersions.find((version) => version.type === 'minecraft')?.id;
                const latestFabricLoader = selectableVersions.find((version) => version.type === 'fabric-loader')?.id;

                setVersions(fetchedVersions);
                setTargetVersion(latestMinecraft || latestFabricLoader || selectableVersions[0]?.id || '');
            } catch (err) {
                setError(err.message || 'Unable to load Minecraft versions');
            } finally {
                setVersionsLoading(false);
            }
        }

        loadVersions();
    }, []);

    useEffect(() => {
        storeBool(STORAGE_KEYS.autoDetectMCVersion, autoDetectMCVersion);
    }, [autoDetectMCVersion]);

    useEffect(() => {
        storeBool(STORAGE_KEYS.includeUnstable, includeUnstable);
    }, [includeUnstable]);

    useEffect(() => {
        storeBool(STORAGE_KEYS.overwrite, overwrite);
    }, [overwrite]);

    useEffect(() => {
        storeBool(STORAGE_KEYS.backup, backup);
    }, [backup]);

    useEffect(() => {
        storeBool(STORAGE_KEYS.deleteOld, deleteOld);
    }, [deleteOld]);

    useEffect(() => {
        storeBool(STORAGE_KEYS.copyNonUpdatable, copyNonUpdatable);
    }, [copyNonUpdatable]);

    async function analyzeFolder(folderPath = modsFolder) {
        try {
            const result = await invoke('mod-updater:analyze', {
                modsFolder: folderPath || undefined
            });

            if (result?.ok) {
                setDetectedMCVersion(result.detectedMCVersion || '');
                setDetectedMCVersionConfidence(result.detectedMCVersionConfidence || 0);
            }
        } catch (err) {
            console.warn('[Mod Updater] Analyze failed:', err);
        }
    }

    async function selectFolder() {
        setError('');

        try {
            const result = await invoke('mod-updater:select-folder');
            if (result?.path) {
                setModsFolder(result.path);
                localStorage.setItem(STORAGE_KEYS.modsFolder, result.path);
                setDetectedMCVersion('');
                setDetectedMCVersionConfidence(0);
                await analyzeFolder(result.path);
            }
        } catch (err) {
            setError(err.message || 'Unable to select mods folder');
        }
    }

    async function checkUpdates() {
        if (busy || versionsLoading || !targetVersion) return;

        setBusy(true);
        setError('');
        setStatus({
            type: 'loading',
            message: `Analyzing ${modsFolder || 'default mods folder'} and checking Fabric mods targeting ${targetVersion}...`
        });
        setMods([]);
        setSelectedModIds(new Set());

        try {
            const result = await invoke('mod-updater:check', {
                targetMCVersion,
                includeUnstable,
                autoDetectMCVersion,
                modsFolder: modsFolder || undefined
            });

            if (!result?.ok) {
                throw new Error(result?.error || 'Unable to check for updates');
            }

            setMods(result.mods || []);
            setDetectedMCVersion(result.detectedMCVersion || detectedMCVersion);
            setDetectedMCVersionConfidence(result.detectedMCVersionConfidence || detectedMCVersionConfidence);
            setSelectedModIds(new Set((result.mods || []).filter((mod) => mod.status === 'found' && mod.hasUpdate).map((mod) => mod.id)));
            setStatus({
                type: 'success',
                message: `Detected ${result.detectedMCVersion || targetVersion} from ${result.mods?.length || 0} Fabric mod${result.mods?.length === 1 ? '' : 's'} in ${result.modsPath || 'the selected folder'}.`
            });
        } catch (err) {
            setError(err.message || 'Unable to check for updates');
            setStatus(null);
        } finally {
            setBusy(false);
        }
    }

    async function downloadSelected() {
        if (busy || !hasSelectedMods) return;

        const outputPreview = overwrite
            ? 'the selected mods folder'
            : `${modsFolder || 'mods'}-updated`;
        const confirmed = overwrite
            ? window.confirm(`Overwrite selected mods in-place and delete old versions? Backup path will be created when backup is enabled.\n\nOutput: ${modsFolder || 'selected mods folder'}`)
            : window.confirm(`Copy selected updates to ${outputPreview}?`);

        if (!confirmed) return;

        setBusy(true);
        setError('');
        setStatus({
            type: 'loading',
            message: `Processing ${selectedMods.length} selected mod${selectedMods.length === 1 ? '' : 's'}...`
        });

        try {
            const result = await invoke('mod-updater:download', {
                modsToDownload: selectedMods,
                allMods: mods,
                modsFolder: modsFolder || undefined,
                overwrite,
                backup,
                deleteOld,
                copyNonUpdatable
            });

            if (!result?.ok) {
                throw new Error(result?.error || 'Unable to process selected mods');
            }

            const downloadedCount = (result.mods || []).filter((mod) => mod.status === 'downloaded').length;
            const errorCount = (result.mods || []).filter((mod) => mod.status === 'error').length;

            setMods((currentMods) => currentMods.map((mod) => {
                const downloaded = (result.mods || []).find((entry) => entry.id === mod.id);
                return downloaded ? { ...mod, ...downloaded } : mod;
            }));
            setSelectedModIds(new Set());
            setStatus({
                type: errorCount > 0 ? 'warning' : 'success',
                message: `Processed ${downloadedCount} update${downloadedCount === 1 ? '' : 's'}${errorCount ? ` with ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}. Output: ${result.outputDir}`
            });
        } catch (err) {
            setError(err.message || 'Unable to process selected mods');
            setStatus(null);
        } finally {
            setBusy(false);
        }
    }

    function toggleMod(modId, checked) {
        setSelectedModIds((current) => {
            const next = new Set(current);
            if (checked) {
                next.add(modId);
            } else {
                next.delete(modId);
            }
            return next;
        });
    }

    function selectAllMods() {
        setSelectedModIds(new Set(selectableMods.map((mod) => mod.id)));
    }

    function deselectAllMods() {
        setSelectedModIds(new Set());
    }

    function clearResults() {
        setMods([]);
        setSelectedModIds(new Set());
        setStatus(null);
        setError('');
    }

    const versionOptions = versions.filter(isSelectableVersion);
    const outputFolder = modsFolder ? `${modsFolder}-updated` : 'mods-updated';
    const copyFolder = modsFolder ? `${modsFolder}-to-update` : 'mods-to-update';

    return (
        <PageShell title="Minecraft Mod Updater" route={route} setRoute={setRoute} leftChildren={
            <div className="modUpdaterSidebar">
                <div className="navBox modUpdaterControls">
                    <h3>Updater Controls</h3>

                    <label className="formField">
                        Mods folder
                        <div className="inlineField">
                            <input
                                value={modsFolder}
                                readOnly
                                placeholder="Select mods folder..."
                                title={modsFolder || 'Default minecraft-mod-updater/mods'}
                            />
                            <button type="button" onClick={selectFolder}>Browse</button>
                        </div>
                    </label>

                    <div className="detectedVersionBox">
                        <span>Detected version</span>
                        <strong>{detectedMCVersion || 'Not analyzed yet'}</strong>
                        {detectedMCVersionConfidence > 0 ? <em>{detectedMCVersionConfidence} mod match{detectedMCVersionConfidence === 1 ? '' : 'es'}</em> : null}
                    </div>

                    <label className="checkRow">
                        <input
                            type="checkbox"
                            checked={autoDetectMCVersion}
                            onChange={(event) => setAutoDetectMCVersion(event.target.checked)}
                            disabled={busy}
                        />
                        Auto-analyze version from selected mods
                    </label>

                    <label className="formField">
                        Target version
                        <select value={targetVersion} onChange={(event) => setTargetVersion(event.target.value)} disabled={versionsLoading || busy}>
                            {versionOptions.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}
                        </select>
                    </label>

                    <label className="checkRow">
                        <input
                            type="checkbox"
                            checked={includeUnstable}
                            onChange={(event) => setIncludeUnstable(event.target.checked)}
                            disabled={busy}
                        />
                        Include unstable builds
                    </label>

                    <label className="checkRow dangerRow">
                        <input
                            type="checkbox"
                            checked={overwrite}
                            onChange={(event) => setOverwrite(event.target.checked)}
                            disabled={busy}
                        />
                        Overwrite mods in-place
                    </label>

                    <label className="checkRow">
                        <input
                            type="checkbox"
                            checked={backup}
                            onChange={(event) => setBackup(event.target.checked)}
                            disabled={busy || !overwrite}
                        />
                        Backup before overwrite
                    </label>

                    <label className="checkRow">
                        <input
                            type="checkbox"
                            checked={deleteOld}
                            onChange={(event) => setDeleteOld(event.target.checked)}
                            disabled={busy || !overwrite}
                        />
                        Delete old versions when overwriting
                    </label>

                    <label className="checkRow">
                        <input
                            type="checkbox"
                            checked={copyNonUpdatable}
                            onChange={(event) => setCopyNonUpdatable(event.target.checked)}
                            disabled={busy || overwrite}
                        />
                        Copy non-updatable mods to {copyFolder}
                    </label>

                    <div className="controlButtonRow">
                        <button type="button" className="full" disabled={busy || versionsLoading || !targetVersion} onClick={checkUpdates}>
                            Analyze & Check Updates
                        </button>
                        <button type="button" className="full" disabled={busy || !hasSelectedMods} onClick={downloadSelected}>
                            Download/Copy Selected
                        </button>
                        <button type="button" className="full" disabled={busy || !mods.length} onClick={clearResults}>
                            Clear Results
                        </button>
                    </div>

                    {error ? <p className="modUpdaterError">{error}</p> : null}
                    {status ? <p className={`modUpdaterStatus ${status.type}`}>{status.message}</p> : null}
                </div>

                <div className="navBox modUpdaterSelectionBox">
                    <h3>Selection</h3>
                    <div className="selectionSummary">{selectedModIds.size} selected</div>
                    <button type="button" className="full" disabled={busy || !selectableMods.length} onClick={selectAllMods}>Select All Updates</button>
                    <button type="button" className="full" disabled={busy || !selectedModIds.size} onClick={deselectAllMods}>Deselect All</button>
                </div>
            </div>
        }>
            <div className="modUpdaterContent">
                <header className="modUpdaterHero">
                    <div>
                        <p className="eyebrow">Fabric / Modrinth</p>
                        <h2>Minecraft Mod Updater</h2>
                        <p>
                            Scan a Minecraft mods folder, compare Fabric mod versions against Modrinth,
                            then download updates into the existing style of Emerald Utilities.
                        </p>
                    </div>
                    <div className="heroStats">
                        <div>
                            <strong>{mods.length}</strong>
                            <span>scanned</span>
                        </div>
                        <div>
                            <strong>{selectableMods.length}</strong>
                            <span>updates</span>
                        </div>
                        <div>
                            <strong>{detectedMCVersion || '—'}</strong>
                            <span>detected</span>
                        </div>
                        <div>
                            <strong>{selectedModIds.size}</strong>
                            <span>selected</span>
                        </div>
                    </div>
                </header>

                {mods.length === 0 ? (
                    <section className="modUpdaterEmpty">
                        <div className="emptySigil">⬡</div>
                        <h3>No scan results yet</h3>
                        <p>Select your mods folder, then run Analyze & Check Updates. The app will detect the current Fabric/Minecraft version so you can update or downgrade to any target version.</p>
                        {outputFolder ? <code>{outputFolder}</code> : null}
                    </section>
                ) : (
                    <section className="modCardsGrid">
                        {mods.map((mod) => (
                            <ModCard
                                key={`${mod.id}-${mod.file || ''}`}
                                mod={mod}
                                selected={selectedModIds.has(mod.id)}
                                onToggle={toggleMod}
                            />
                        ))}
                    </section>
                )}
            </div>
        </PageShell>
    );
}
