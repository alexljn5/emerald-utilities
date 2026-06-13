// src/globals.js
const versionNumber = "0.0.7";

window.versionNumber = versionNumber;

document.addEventListener('DOMContentLoaded', () => {
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }
});