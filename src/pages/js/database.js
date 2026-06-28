// src/pages/js/database.js
import { versionNumber } from "../../globals.js";

document.addEventListener("DOMContentLoaded", () => {
    const versionEl = document.getElementById("versionDisplay");
    if (versionEl) {
        versionEl.textContent = `v${versionNumber}`;
    }

    const dbStatusEl = document.getElementById("dbStatus");
    const importLogEl = document.getElementById("importLog");
    const networkFileSelect = document.getElementById("networkFileSelect");
    const importNetworkBtn = document.getElementById("importNetworkBtn");
    const importGrokBtn = document.getElementById("importGrokBtn");
    const importBlacklistBtn = document.getElementById("importBlacklistBtn");
    const clearLogBtn = document.getElementById("clearLogBtn");
    const refreshStatsBtn = document.getElementById("refreshStats");

    function addLogEntry(message) {
        const entry = document.createElement("div");
        entry.className = "logEntry";
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        importLogEl.appendChild(entry);
        importLogEl.scrollTop = importLogEl.scrollHeight;
    }

    function clearLog() {
        importLogEl.innerHTML = "";
    }

    async function loadStats() {
        try {
            const result = await window.electronAPI.invoke("database:get-stats");
            if (result && result.connected) {
                dbStatusEl.textContent = "Connected";
                dbStatusEl.className = "statusConnected";
            } else {
                dbStatusEl.textContent = "Disconnected";
                dbStatusEl.className = "statusDisconnected";
            }

            document.getElementById("statTotalPackets").textContent = result.totalPackets ?? 0;
            document.getElementById("statGrokMessages").textContent = result.grokMessages ?? 0;
            document.getElementById("statGrokConversations").textContent = result.grokConversations ?? 0;
            document.getElementById("statActiveThreats").textContent = result.activeThreats ?? 0;
            document.getElementById("statBlacklistedPackets").textContent = result.blacklistedPackets ?? 0;
            document.getElementById("statConnected").textContent = result.connected ? "Yes" : "No";
        } catch (err) {
            dbStatusEl.textContent = "Error";
            dbStatusEl.className = "statusDisconnected";
            console.error("Failed to load database stats:", err);
        }
    }

    async function loadNetworkFiles() {
        try {
            const result = await window.electronAPI.invoke("network-logs:list", { folder: "ALL" });
            const files = result.files || [];
            networkFileSelect.innerHTML = '<option value="">-- Select a file --</option>';
            for (const f of files) {
                const option = document.createElement("option");
                option.value = f;
                option.textContent = f;
                networkFileSelect.appendChild(option);
            }
        } catch (err) {
            console.error("Failed to load network files:", err);
        }
    }

    async function importNetworkLog() {
        const selectedFile = networkFileSelect.value;
        if (!selectedFile) {
            addLogEntry("Please select a file first.");
            return;
        }

        importNetworkBtn.disabled = true;
        addLogEntry(`Importing ${selectedFile}...`);
        try {
            const result = await window.electronAPI.invoke("database:import-network-log", { file: selectedFile });
            addLogEntry(`Imported ${result.imported} packets (${result.failed} failed)`);
            await loadStats();
        } catch (err) {
            addLogEntry(`Error: ${err.message}`);
        } finally {
            importNetworkBtn.disabled = false;
            networkFileSelect.value = "";
        }
    }

    async function importGrokExport() {
        importGrokBtn.disabled = true;
        addLogEntry("Select Grok export JSON file...");
        try {
            const result = await window.electronAPI.invoke("database:import-grok-export");
            addLogEntry(`Imported ${result.importedMessages} messages from ${result.importedConversations} conversations`);
            await loadStats();
        } catch (err) {
            addLogEntry(`Error: ${err.message}`);
        } finally {
            importGrokBtn.disabled = false;
        }
    }

    async function importBlacklist() {
        importBlacklistBtn.disabled = true;
        addLogEntry("Importing blacklisted IPs...");
        try {
            const result = await window.electronAPI.invoke("database:import-blacklist");
            addLogEntry(`Imported ${result.count} threat indicators`);
            await loadStats();
        } catch (err) {
            addLogEntry(`Error: ${err.message}`);
        } finally {
            importBlacklistBtn.disabled = false;
        }
    }

    refreshStatsBtn.addEventListener("click", loadStats);
    importNetworkBtn.addEventListener("click", importNetworkLog);
    importGrokBtn.addEventListener("click", importGrokExport);
    importBlacklistBtn.addEventListener("click", importBlacklist);
    clearLogBtn.addEventListener("click", clearLog);

    loadStats();
    loadNetworkFiles();
});
