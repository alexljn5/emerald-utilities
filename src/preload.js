const { ipcRenderer } = require('electron');
console.log('[preload] loaded');

window.electronAPI = {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, callback) => {
        const listener = (_event, ...payload) => callback(...payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    }
};
