const { contextBridge, ipcRenderer } = require('electron');
const { scriptManager } = require('./core/scriptManager');
contextBridge.exposeInMainWorld('electronAPI', {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, callback) => ipcRenderer.on(channel, callback),
});


contextBridge.exposeInMainWorld('scriptManager', scriptManager);

