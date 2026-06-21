// src/globals.js
export const versionNumber = "0.1.0";

window.versionNumber = versionNumber;

document.addEventListener('DOMContentLoaded', () => {
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }
});