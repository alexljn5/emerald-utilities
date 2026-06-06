// src/globals.js
const versionNumber = "0.0.5";

window.versionNumber = versionNumber;
window.PRODUCTION = true;   // ← Hardcode for now or pass via IPC later

document.addEventListener('DOMContentLoaded', () => {
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }
});