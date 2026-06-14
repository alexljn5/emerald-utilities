import { versionNumber } from '../../globals.js';

document.addEventListener('DOMContentLoaded', () => {

    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.innerText = `v${versionNumber}`;
    }

    const modal = document.getElementById('aboutModal');
    const btn = document.getElementById('aboutButton');
    const span = document.getElementsByClassName('close')[0];


    if (!modal || !btn || !span) return;

    btn.onclick = () => {
        modal.style.display = 'block';
    };

    span.onclick = () => {
        modal.style.display = 'none';
    };

    window.onclick = (event) => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    };
});

const modalVersion = document.getElementById('modalVersion');
if (modalVersion) {
    modalVersion.innerText = `v${versionNumber}`;
}