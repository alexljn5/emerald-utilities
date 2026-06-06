// src/globals.js
const versionNumber = "0.0.6";

window.versionNumber = versionNumber;
//Later make that flag in here, this didnt work
//window.PRODUCTION = true;   // ← Hardcode for now or pass via IPC later

document.addEventListener('DOMContentLoaded', () => {
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }
});