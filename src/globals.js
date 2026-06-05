const versionNumber = "0.0.3";

module.exports = { versionNumber };

document.addEventListener('DOMContentLoaded', () => {

    const versionDisplay = document.getElementById('versionDisplay');
    const scriptToolButton = document.getElementById('scriptToolButton');
    const aboutButton = document.getElementById('aboutButton');

    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }

    scriptToolButton?.addEventListener('click', () => {
        window.location.href = './pages/script_tool.html';
    });

    aboutButton?.addEventListener('click', () => {
        window.location.href = './pages/about.html';
    });

});