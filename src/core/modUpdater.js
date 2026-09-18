import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

function getFallbackVersions() {
    return [
        { id: '26.1', name: '26.1', type: 'fabric-loader' },
        { id: '26.0', name: '26.0', type: 'fabric-loader' },
        { id: '25.1', name: '25.1', type: 'fabric-loader' },
        { id: '25.0', name: '25.0', type: 'fabric-loader' },
        { id: '---', name: '--- Minecraft Release Versions ---', type: 'separator', disabled: true },
        { id: '1.21.6', name: '1.21.6', type: 'minecraft' },
        { id: '1.21.5', name: '1.21.5', type: 'minecraft' },
        { id: '1.20.1', name: '1.20.1', type: 'minecraft' },
        { id: '1.20', name: '1.20', type: 'minecraft' },
        { id: '1.19.3', name: '1.19.3', type: 'minecraft' },
        { id: '1.19.2', name: '1.19.2', type: 'minecraft' },
        { id: '1.19', name: '1.19', type: 'minecraft' }
    ];
}

function compareVersions(a, b) {
    const pa = String(a).split('.').map((part) => parseInt(part, 10));
    const pb = String(b).split('.').map((part) => parseInt(part, 10));
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i += 1) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }

    return 0;
}

export async function getMinecraftVersions() {
    const versions = [];

    try {
        const loaderResponse = await fetch('https://api.modrinth.com/v2/tag/loader');
        const loaders = await loaderResponse.json();
        const fabricLoader = loaders.find((loader) => loader.name === 'Fabric');

        if (fabricLoader?.loaders) {
            const fabricVersions = fabricLoader.loaders
                .slice(0, 50)
                .map((loader) => ({
                    id: loader.version,
                    name: loader.version,
                    type: 'fabric-loader'
                }));

            const unique = Array.from(new Map(fabricVersions.map((version) => [version.id, version])).values());
            unique.sort((x, y) => {
                try {
                    return compareVersions(y.id, x.id);
                } catch {
                    return 0;
                }
            });

            versions.push(...unique);
        }
    } catch (err) {
        console.error('[Mod Updater] Failed to fetch Fabric versions:', err);
    }

    versions.push({
        id: '---',
        name: '--- Minecraft Release Versions ---',
        type: 'separator',
        disabled: true
    });

    try {
        const mcResponse = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const mcData = await mcResponse.json();

        const releaseVersions = mcData.versions
            .filter((version) => version.type === 'release')
            .sort((a, b) => new Date(b.releaseTime) - new Date(a.releaseTime))
            .map((version) => ({
                id: version.id,
                name: version.id,
                type: 'minecraft'
            }));

        versions.push(...releaseVersions);
    } catch (err) {
        console.error('[Mod Updater] Failed to fetch Minecraft versions:', err);
    }

    return versions.length > 0 ? versions : getFallbackVersions();
}

function readFabricModJson(fullPath) {
    const zip = new AdmZip(fullPath);
    const entry = zip.getEntry('fabric.mod.json');

    if (!entry) {
        return null;
    }

    return JSON.parse(entry.getData().toString('utf8'));
}

function normalizeVersionCandidate(candidate) {
    if (!candidate) return null;

    const normalized = String(candidate)
        .trim()
        .replace(/^v/i, '')
        .replace(/^minecraft[-_.]?/i, '')
        .replace(/^mc[-_.]?/i, '')
        .replace(/[-_.](?:fabric|forge|quilt)$/i, '')
        .replace(/\.0+$/g, '');

    if (!/^\d+(?:\.\d+){0,3}$/.test(normalized)) {
        return null;
    }

    return normalized;
}

function extractVersionCandidates(text, source, existing = []) {
    const candidates = [...existing];
    const addCandidate = (candidate) => {
        const normalized = normalizeVersionCandidate(candidate);
        if (normalized && !candidates.includes(normalized)) {
            candidates.push({ version: normalized, source });
        }
    };

    const patterns = [
        /(?:^|[-_.])(?:mc|minecraft)[-_.]?(\d+(?:\.\d+){1,3})/gi,
        /minecraft[-_.]?(\d+(?:\.\d+){1,3})/gi,
        /(?:^|[-_+])(\d+(?:\.\d+){1,3})(?:[-_.](?:fabric|mc|minecraft)|$)/gi
    ];

    if (source !== 'filename') {
        patterns.push(/[<>=~^]?\s*v?(\d+(?:\.\d+){1,3})/g);
    }

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(String(text || ''))) !== null) {
            addCandidate(match[1]);
        }
    }

    return candidates;
}

function chooseDetectedVersion(candidates) {
    const counts = new Map();

    for (const candidate of candidates) {
        counts.set(candidate.version, (counts.get(candidate.version) || 0) + 1);
    }

    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;

    return {
        version: entries[0][0],
        confidence: entries[0][1]
    };
}

export function scanMods(modFolder) {
    if (!modFolder || !fs.existsSync(modFolder)) {
        return [];
    }

    const files = fs.readdirSync(modFolder);
    const mods = [];

    for (const file of files) {
        if (!file.toLowerCase().endsWith('.jar')) continue;

        const fullPath = path.join(modFolder, file);

        try {
            const content = readFabricModJson(fullPath);

            if (!content?.id || !content?.version) continue;

            const detectedCandidates = [
                ...extractVersionCandidates(file, 'filename'),
                ...extractVersionCandidates(content.depends?.minecraft, 'fabric.mod.json depends.minecraft')
            ];
            const detectedMCVersion = chooseDetectedVersion(detectedCandidates.map((candidate) => ({ version: candidate.version })))?.version || null;

            mods.push({
                id: String(content.id),
                version: String(content.version),
                file,
                detectedMCVersion,
                detectedMCVersionCandidates: detectedCandidates.map((candidate) => candidate.version)
            });
        } catch (err) {
            console.warn(`[Mod Updater] Failed to read mod jar ${file}:`, err.message);
        }
    }

    return mods;
}

export function analyzeModsFolder(modFolder) {
    const mods = scanMods(modFolder);
    const candidates = [];

    for (const mod of mods) {
        for (const version of mod.detectedMCVersionCandidates || []) {
            candidates.push({ version, source: mod.file });
        }
    }

    const detected = chooseDetectedVersion(candidates);

    return {
        mods,
        detectedMCVersion: detected?.version || null,
        detectedMCVersionConfidence: detected?.confidence || 0
    };
}

export async function searchProjectSmart(modId, targetMCVersion) {
    const normalizedId = String(modId || '').replace(/_/g, '-').trim();

    if (!normalizedId) {
        return null;
    }

    const searchResponse = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(normalizedId)}`);
    if (!searchResponse.ok) {
        throw new Error(`Modrinth search failed: ${searchResponse.status} ${searchResponse.statusText}`);
    }

    const data = await searchResponse.json();
    const hits = data.hits || [];
    if (hits.length === 0) {
        return null;
    }

    const scored = await Promise.all(hits.map(async (hit) => {
        const slugLower = String(hit.slug || '').toLowerCase();
        const normalizedIdLower = normalizedId.toLowerCase();
        let score = 0;

        if (slugLower === normalizedIdLower) {
            score += 100;
        } else if (slugLower.includes(normalizedIdLower) || normalizedIdLower.includes(slugLower)) {
            score += 50;
        }

        try {
            const projectResponse = await fetch(`https://api.modrinth.com/v2/project/${hit.project_id}`);
            if (!projectResponse.ok) {
                return { project: hit, score };
            }

            const fullProject = await projectResponse.json();

            if (fullProject.loaders?.includes('fabric')) score += 2;
            if (fullProject.game_versions?.includes(targetMCVersion)) score += 1;

            return { project: fullProject, score };
        } catch {
            return { project: hit, score };
        }
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored[0].score > 0 ? scored[0].project : null;
}

export async function getVersions(projectId, targetMCVersion, includeUnstable = false) {
    if (!projectId) {
        return [];
    }

    const response = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`);
    if (!response.ok) {
        throw new Error(`Failed to fetch versions: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (!text) {
        return [];
    }

    const versions = JSON.parse(text);
    let filtered = versions.filter((version) => (
        version.loaders?.includes('fabric') &&
        version.game_versions?.includes(targetMCVersion)
    ));

    if (!includeUnstable) {
        filtered = filtered.filter((version) => version.version_type === 'release');
    }

    return filtered;
}

async function downloadMod(version, modId, outputPath) {
    if (!version?.files?.length) {
        throw new Error('No files available for this version');
    }

    const primaryFile = version.files.find((file) => file.primary) || version.files[0];
    if (!primaryFile?.url) {
        throw new Error('No primary file found');
    }

    fs.mkdirSync(outputPath, { recursive: true });

    const downloadUrl = primaryFile.url;
    const filename = primaryFile.filename || `${modId}-${version.version_number}.jar`;
    const outputFile = path.join(outputPath, filename);
    const response = await fetch(downloadUrl);

    if (!response.ok) {
        throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);

    return outputFile;
}

function emptyDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        return;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(fullPath);
            }
        } catch (err) {
            console.warn(`[Mod Updater] Failed to remove ${fullPath}:`, err.message);
        }
    }
}

function removeOldVersions(modId, modsPath, backup) {
    if (!fs.existsSync(modsPath)) return;

    const filesInMods = fs.readdirSync(modsPath);
    for (const file of filesInMods) {
        if (!file.toLowerCase().endsWith('.jar')) continue;

        const filePath = path.join(modsPath, file);
        try {
            const zip = new AdmZip(filePath);
            const entry = zip.getEntry('fabric.mod.json');
            if (!entry) continue;

            const content = JSON.parse(entry.getData().toString('utf8'));
            if (content.id !== modId) continue;

            if (backup) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupDir = path.join(path.dirname(modsPath), `${path.basename(modsPath)}-backup-${timestamp}`);
                fs.mkdirSync(backupDir, { recursive: true });
                fs.copyFileSync(filePath, path.join(backupDir, file));
                console.log(`[Mod Updater] Backed up ${file}`);
            }

            fs.unlinkSync(filePath);
            console.log(`[Mod Updater] Deleted old version: ${file}`);
        } catch (err) {
            console.warn(`[Mod Updater] Failed to clean old version ${file}:`, err.message);
        }
    }
}

function getUpdatedFolder(modsPath) {
    return path.join(path.dirname(modsPath), `${path.basename(modsPath)}-updated`);
}

function getToCopyFolder(modsPath) {
    return path.join(path.dirname(modsPath), `${path.basename(modsPath)}-to-update`);
}

/**
 * Get the still-needs-updating archive folder.
 * Old mods from a previous MC version are moved here, organized by
 * their old version number (e.g. still-needs-updating/26.2/).
 */
function getStillNeedsUpdatingFolder(modsPath) {
    return path.join(path.dirname(modsPath), 'still-needs-updating');
}

/**
 * Archive outdated mods to a version-named subdirectory.
 *
 * When updating from MC version A to B, mods that were for version A
 * (and were not updated to B) are moved to:
 *   still-needs-updating/A/
 *
 * This preserves them instead of deleting, while keeping the main
 * mods folder clean with only the current version's mods.
 *
 * @param {string} modsPath - Path to the mods folder
 * @param {string} oldMCVersion - The previous MC version (e.g. "26.2")
 * @param {Set<string>} updatedModIds - Mod IDs that were successfully updated (these stay)
 * @returns {Array<{id, file, archivedTo}>}
 */
function archiveOutdatedMods(modsPath, oldMCVersion, updatedModIds) {
    if (!fs.existsSync(modsPath)) return [];

    const stillNeedsBase = getStillNeedsUpdatingFolder(modsPath);
    const archiveDir = path.join(stillNeedsBase, String(oldMCVersion));
    const archived = [];

    const files = fs.readdirSync(modsPath);
    for (const file of files) {
        if (!file.toLowerCase().endsWith('.jar')) continue;

        const filePath = path.join(modsPath, file);
        try {
            const zip = new AdmZip(filePath);
            const entry = zip.getEntry('fabric.mod.json');
            if (!entry) continue;

            const content = JSON.parse(entry.getData().toString('utf8'));
            const modId = String(content.id);

            // Skip mods that were updated — they belong in the main folder
            if (updatedModIds.has(modId)) continue;

            // This mod is from the old version and wasn't updated — archive it
            fs.mkdirSync(archiveDir, { recursive: true });
            const target = path.join(archiveDir, file);
            fs.renameSync(filePath, target);
            archived.push({ id: modId, file, archivedTo: target });
            console.log(`[Mod Updater] Archived outdated mod ${file} → still-needs-updating/${oldMCVersion}/`);
        } catch (err) {
            console.warn(`[Mod Updater] Failed to archive ${file}:`, err.message);
        }
    }

    return archived;
}

export function getDefaultModsFolder(app) {
    const devPath = path.join(app.getAppPath(), 'minecraft-mod-updater', 'mods');
    if (fs.existsSync(devPath)) {
        return devPath;
    }

    return path.join(app.getPath('userData'), 'mods');
}

export function resolveModsFolder(modsFolder, app) {
    if (modsFolder) {
        return path.resolve(modsFolder);
    }

    return getDefaultModsFolder(app);
}

export async function checkModUpdates({
    targetMCVersion,
    includeUnstable,
    modsFolder,
    app,
    autoDetectMCVersion = false
}) {
    const modsPath = resolveModsFolder(modsFolder, app);
    const analysis = analyzeModsFolder(modsPath);
    const mods = analysis.mods;
    const effectiveTargetVersion = targetMCVersion;
    const results = [];

    if (autoDetectMCVersion && !analysis.detectedMCVersion) {
        return {
            ok: false,
            modsPath,
            mods,
            error: 'Unable to auto-detect the Minecraft/Fabric version from the selected mods folder.',
            analysis
        };
    }

    for (const mod of mods) {
        try {
            const project = await searchProjectSmart(mod.id, effectiveTargetVersion);

            if (!project) {
                results.push({
                    id: mod.id,
                    file: mod.file,
                    status: 'not_found',
                    currentVersion: mod.version,
                    detectedMCVersion: mod.detectedMCVersion || analysis.detectedMCVersion,
                    targetVersion: effectiveTargetVersion
                });
                continue;
            }

            const versions = await getVersions(project.id, effectiveTargetVersion, includeUnstable);

            if (versions.length === 0) {
                results.push({
                    id: mod.id,
                    file: mod.file,
                    status: 'no_compatible',
                    currentVersion: mod.version,
                    projectName: project.title,
                    detectedMCVersion: mod.detectedMCVersion || analysis.detectedMCVersion,
                    targetVersion: effectiveTargetVersion
                });
                continue;
            }

            const latestVersion = versions[0];
            const hasUpdate = latestVersion.version_number !== mod.version;

            results.push({
                id: mod.id,
                file: mod.file,
                status: 'found',
                currentVersion: mod.version,
                latestVersion: latestVersion.version_number,
                projectName: project.title,
                hasUpdate,
                versionData: latestVersion,
                detectedMCVersion: mod.detectedMCVersion || analysis.detectedMCVersion,
                targetVersion: effectiveTargetVersion
            });
        } catch (err) {
            results.push({
                id: mod.id,
                file: mod.file,
                status: 'error',
                currentVersion: mod.version,
                error: err.message,
                detectedMCVersion: mod.detectedMCVersion || analysis.detectedMCVersion,
                targetVersion: effectiveTargetVersion
            });
        }
    }

    return {
        ok: true,
        modsPath,
        mods: results,
        detectedMCVersion: analysis.detectedMCVersion,
        detectedMCVersionConfidence: analysis.detectedMCVersionConfidence,
        autoDetectedMCVersion: Boolean(autoDetectMCVersion),
        analysis
    };
}

export async function processModDownloads({
    modsToDownload,
    allMods,
    modsFolder,
    overwrite,
    backup,
    deleteOld,
    copyNonUpdatable,
    previousMCVersion,
    archiveOutdated,
    app
}) {
    const modsPath = resolveModsFolder(modsFolder, app);
    const modsUpdatedPath = getUpdatedFolder(modsPath);
    const modsToCopyPath = getToCopyFolder(modsPath);
    const outputDir = overwrite ? modsPath : modsUpdatedPath;
    const results = [];
    const updatedModIds = new Set();

    fs.mkdirSync(modsPath, { recursive: true });

    if (!overwrite) {
        emptyDirectory(modsUpdatedPath);

        if (copyNonUpdatable) {
            emptyDirectory(modsToCopyPath);
        }
    }

    const selectedIds = new Set((modsToDownload || []).map((mod) => mod.id));

    if (!overwrite && copyNonUpdatable) {
        for (const mod of allMods || []) {
            if (selectedIds.has(mod.id) || !mod.file) continue;

            const source = path.join(modsPath, mod.file);
            const target = path.join(modsToCopyPath, mod.file);

            try {
                if (fs.existsSync(source)) {
                    fs.copyFileSync(source, target);
                }
            } catch (err) {
                results.push({
                    id: mod.id,
                    file: mod.file,
                    status: 'error',
                    error: `Failed to copy non-updatable mod: ${err.message}`
                });
            }
        }
    }

    for (const mod of modsToDownload || []) {
        try {
            if (!mod.hasUpdate) {
                results.push({
                    id: mod.id,
                    file: mod.file,
                    status: 'up-to-date'
                });
                continue;
            }

            if (overwrite && deleteOld) {
                removeOldVersions(mod.id, modsPath, backup);
            }

            const downloadedPath = await downloadMod(mod.versionData, mod.id, outputDir);
            updatedModIds.add(mod.id);
            results.push({
                id: mod.id,
                file: mod.file,
                status: 'downloaded',
                filename: downloadedPath ? path.basename(downloadedPath) : mod.versionData?.files?.[0]?.filename
            });
        } catch (err) {
            results.push({
                id: mod.id,
                file: mod.file,
                status: 'error',
                error: err.message
            });
        }
    }

    // --- Archive outdated mods ---
    // After downloading updates, any remaining mods in the main folder
    // that weren't updated get moved to still-needs-updating/<old-version>/
    // so the user can review them later without losing them.
    let archived = [];
    if (archiveOutdated && previousMCVersion && overwrite) {
        archived = archiveOutdatedMods(modsPath, previousMCVersion, updatedModIds);
    }

    return {
        ok: true,
        modsPath,
        outputDir,
        copiedDir: (!overwrite && copyNonUpdatable) ? modsToCopyPath : null,
        archivedDir: archived.length > 0 ? getStillNeedsUpdatingFolder(modsPath) : null,
        archived,
        mods: results
    };
}
