// src/globals.js
export const versionNumber = "0.0.8";

window.versionNumber = versionNumber;

document.addEventListener('DOMContentLoaded', () => {
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }
});