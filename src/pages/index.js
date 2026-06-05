// src/pages/index.js
import { scriptManager } from "../core/scriptManager.js";

document.addEventListener("DOMContentLoaded", () => {
    // Version display
    const versionEl = document.getElementById("versionDisplay");
    if (versionEl && typeof versionNumber !== "undefined") {
        versionEl.textContent = `v${versionNumber}`;
    }

    // About button
    const aboutBtn = document.getElementById("aboutButton");
    if (aboutBtn) {
        aboutBtn.addEventListener("click", () => {
            window.location.href = "./pages/about.html";
        });
    }

    // Script Tool button
    const scriptToolBtn = document.getElementById("scriptToolButton");
    if (scriptToolBtn) {
        scriptToolBtn.addEventListener("click", () => {
            window.location.href = "./pages/script_tool.html";
        });
    }

    // Background auto-run scripts (this is what prints the creepy message)
    scriptManager.init({ bindUI: false });

    // Expose for console debugging
    window.scriptManager = scriptManager;

    console.log("%c[Emerald] Dashboard initialized", "color:#ff4444");
});

// After scriptManager.init({ bindUI: false });

// Simple logger for dashboard terminal
function dashboardLog(msg) {
    const term = document.getElementById('terminalOutput');
    if (!term) return;

    const line = document.createElement('div');
    line.textContent = msg;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
}

// Bind it so background scripts appear on the main dashboard too
scriptManager.bindLogger(dashboardLog);

// Replay previous startup logs into the dashboard terminal
scriptManager.replayStartupLogToTerminal(25);