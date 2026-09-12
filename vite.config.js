import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

export default defineConfig({
    plugins: [
        react(),
        electron([
            {
                // 1. Core Backend / Main Process
                entry: 'src/heavensgate.js',
                // node-notifier is a CommonJS module that relies on __dirname to
                // locate its vendored SnoreToast.exe. Bundle it as an external so
                // it is loaded from node_modules at runtime (native CJS) instead of
                // being inlined into the ESM main bundle where __dirname is undefined.
                vite: {
                    build: {
                        rollupOptions: {
                            external: ['node-notifier'],
                        },
                    },
                },
            },
            {
                // 2. Preload Script / IPC Bridge (Fixes the undefined 'invoke' error)
                entry: 'src/preload.js',
                onstart(options) {
                    // Hot-reload the renderer process when the preload script changes during dev
                    options.reload();
                },
            },
        ]),
    ],
    base: './',
    server: {
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        hmr: {
            protocol: 'ws',
            host: '127.0.0.1',
            port: 5173
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    },
    ssr: {
        noExternal: ['pg', 'dotenv'],
        external: ['node-notifier'],
    },
});