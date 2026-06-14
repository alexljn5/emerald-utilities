const electronAPI = typeof window !== 'undefined' ? window.electronAPI : null;

export function invoke(channel, ...args) {
    if (!electronAPI?.invoke) {
        throw new Error(`Electron invoke API is not available for ${channel}`);
    }

    return electronAPI.invoke(channel, ...args);
}

export function on(channel, callback) {
    if (!electronAPI?.on) {
        return () => { };
    }

    return electronAPI.on(channel, callback);
}
