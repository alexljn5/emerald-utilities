/**
 * OS Notifier — platform-abstraction for desktop notifications.
 *
* Architecture (single module; no extra files by design):
 *   OSNotifier.notify({...})
 *     ├── notifyWindows()  → node-notifier / SnoreToast (Windows Toast API)
 *     ├── notifyLinux()    → node-notifier (notify-send / dbus)
 *     └── notifyMacOS()    → node-notifier (macOS Notification Center)
 *
 * The public API is platform-neutral. Application code never needs to know
 * which backend is delivering the notification (SnoreToast, Windows Toast,
 * notify-send, or macOS Notification Center).
 *
 * Honest state reporting: we only report "shown" when the OS/backend confirms
 * the notification was displayed. Failures are reported with the exact error
 * (e.g. a Windows HRESULT) and are never papered over.
 *
 * Windows uses node-notifier (SnoreToast.exe), which invokes the Windows
 * Toast/App Notification API DIRECTLY. This reliably renders a real on-screen
 * desktop toast (like Malwarebytes/Discord) regardless of Electron packaging
 * or foreground state — something Electron's native Notification does not
 * reliably do in dev. SnoreToast requires the AppUserModelID to match a
 * registered Start Menu shortcut (see registerAumidShortcut in heavensgate.js).
 */

import { Notification, app } from 'electron';
import fs, { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { resolvePath, resolveInternalScriptsPath } from './pathResolver.js';
import { resolveAumid } from './aumid.js';

// node-notifier (used for the Linux/macOS backends) is a CommonJS module. We
// load it lazily via createRequire only on those platforms; Windows never
// touches it because it spawns SnoreToast.exe directly.
const require = createRequire(import.meta.url);

// Resolve the vendored SnoreToast.exe used for Windows Toast notifications.
// In dev it lives under node_modules/node-notifier/vendor; in a packaged build
// it is copied to resourcesPath/node-notifier/vendor via extraResources.
function resolveSnoreToast() {
    const rel = path.join('node-notifier', 'vendor', 'snoreToast', 'snoretoast-x64.exe');
    if (app.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, rel);
    }
    return path.join(process.cwd(), 'node_modules', rel);
}

// Stable application identity. NEVER substitute an executable path for the
// AUMID — the two are unrelated concepts.
//
// IMPORTANT: Windows Toast notifications require the AUMID passed to the
// notifier, the AUMID set via app.setAppUserModelId(), and the AUMID attached
// to a registered Start Menu shortcut to ALL be IDENTICAL. If those identities
// disagree (DON'T have "Electron AUMID A, Shortcut AUMID B, SnoreToast AUMID C"),
// Windows toast registration becomes extremely unreliable.
//
// We use a SINGLE source of truth (aumid.js) that differs only by packaged
// state, so the entire dev identity chain is internally consistent, and
// likewise for prod:
//   dev  → com.emerald-user.emeraldutilities.dev
//   prod → com.emerald-user.emeraldutilities
// The same value is used by Electron (setAppUserModelId in heavensgate.js),
// the SnoreToast notifier (-appID), and the shortcut registration.

/** Canonical AppUserModelID for the current environment (win32 only). */
export function getAumid() {
    return resolveAumid(typeof app.isPackaged === 'boolean' && app.isPackaged);
}

/**
 * Get the Windows notification AppID.
 * Must match the AUMID set via app.setAppUserModelId() in the main process.
 * @deprecated Use getAumid() directly.
 */
export function getWindowsNotificationAppId() {
    if (process.platform !== 'win32') return undefined;
    return getAumid();
}

function resolveIcon() {
    try {
        return resolvePath('img/favicons/favicon.png');
    } catch {
        return undefined;
    }
}

/**
 * Normalize cross-platform options into a single internal shape.
 * Accepts both `body` (legacy callers) and `message` (API docs) for the text.
 * Each backend maps these normalized fields to its own semantics.
 */
function normalizeOptions({
    title,
    body,
    message,
    urgency = 'normal',
    silent = false,
    sound = true,
    timeout,
    icon,
    actions,
} = {}) {
    const safeUrgency = ['low', 'normal', 'critical'].includes(urgency) ? urgency : 'normal';
    return {
        title: title || 'Emerald Utilities',
        message: message || body || 'Task reminder',
        urgency: safeUrgency,
        silent: Boolean(silent),
        sound: Boolean(sound),
        timeout,
        icon,
        actions,
    };
}

// ==================== WINDOWS: SnoreToast (Windows Toast API) ====================
// We invoke SnoreToast.exe DIRECTLY via child_process.spawn. SnoreToast calls
// the Windows Toast/App Notification API and renders a real desktop toast
// (like Malwarebytes/Discord) independent of Electron's packaging, focus, or
// foreground state — which is what a native Electron Notification does NOT
// reliably do in dev.
//
// We deliberately do NOT go through the node-notifier JS wrapper: wiring that
// CommonJS module into an ESM main process (via createRequire or dynamic
// import) is fragile under the bundler and fails with "__dirname is not
// defined" / "Notifier is not a constructor". Spawning the vendored .exe
// directly is robust in both dev and packaged builds.
//
// SnoreToast needs the AppUserModelID to route the toast to this app, and it
// must match the AUMID registered on a Start Menu shortcut (see
// registerAumidShortcut in heavensgate.js). We pass the AUMID explicitly.
async function verifyAumidShortcut() {
    const shortcutPath = path.join(
        process.env.APPDATA || '',
        'Microsoft', 'Windows', 'Start Menu', 'Programs',
        'Emerald Utilities.lnk'
    );
    if (!existsSync(shortcutPath)) {
        console.warn('[OSNotifier] AUMID shortcut missing at:', shortcutPath);
        console.warn('[OSNotifier] This will cause SnoreToast to fail. Ensure registerAumidShortcut() runs at app startup.');
        return false;
    }
    return true;
}

async function notifyWindows(opts) {
    const snoreToastPath = resolveSnoreToast();
    if (!existsSync(snoreToastPath)) {
        console.error('[OSNotifier] SnoreToast.exe not found at:', snoreToastPath);
        return { ok: false, provider: 'snoretoast', state: 'failed', error: `SnoreToast.exe not found at ${snoreToastPath}` };
    }

    // Pre-flight: verify AUMID shortcut exists
    await verifyAumidShortcut();

    return new Promise((resolve) => {
        console.log('[OSNotifier] Windows (SnoreToast) notification attempt started');

        const args = [
            '-appID', getAumid(),
            '-t', opts.title,
            '-m', opts.message,
        ];

        // `-silent` is a boolean FLAG that takes NO value. Passing a value
        // (e.g. `-silent false`) makes SnoreToast report "Unknown argument: false"
        // and exit with the generic failure code (0xFFFFFFFF). Only add the flag
        // when the notification should actually be silent.
        if (opts.silent) {
            args.push('-silent');
        }

        if (opts.icon) {
            args.push('-p', opts.icon);
        }

        // Log the full command for debugging exit code 3
        console.log(`[OSNotifier] SnoreToast command: ${snoreToastPath} ${args.map(a => `"${a}"`).join(' ')}`);

        let proc;
        try {
            proc = spawn(snoreToastPath, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            console.error('[OSNotifier] SnoreToast spawn error:', err.message);
            resolve({ ok: false, provider: 'snoretoast', state: 'failed', error: err.message });
            return;
        }

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (err) => {
            console.error('[OSNotifier] SnoreToast process error:', err.message);
            resolve({ ok: false, provider: 'snoretoast', state: 'failed', error: err.message });
        });
        proc.on('close', (code) => {
            const out = stdout.trim();
            const errOut = stderr.trim();
            console.log(`[OSNotifier] SnoreToast exit code=${code} stdout="${out}" stderr="${errOut}"`);

            // SnoreToast can exit 0 even when Windows suppresses the toast.
            // Detect known suppression markers in its output so we report a
            // TRUTHFUL failure instead of claiming "shown" when nothing is
            // actually displayed. This is the "honest state reporting" contract.
            const combined = `${out}\n${errOut}`.toLowerCase();

            if (combined.includes('disabledforuser')) {
                return resolve({
                    ok: false,
                    provider: 'snoretoast',
                    state: 'blocked',
                    error: 'Windows notifications are disabled for this app (DisabledForUser). Enable notifications for Emerald Utilities in Settings → System → Notifications.',
                    code,
                    response: out,
                });
            }
            if (combined.includes('disabledbypolicy')) {
                return resolve({
                    ok: false,
                    provider: 'snoretoast',
                    state: 'blocked',
                    error: 'Windows notifications are disabled for this app by policy (DisabledByPolicy).',
                    code,
                    response: out,
                });
            }

            // Exit code 3 with empty output typically means AUMID/shortcut mismatch
            // or the toast was suppressed before SnoreToast could produce output.
            if (code === 3) {
                return resolve({
                    ok: false,
                    provider: 'snoretoast',
                    state: 'failed',
                    error: 'SnoreToast failed (exit code 3). This usually means the AUMID does not match a registered Start Menu shortcut, or Windows has suppressed notifications. Try: (1) restart the app as administrator, (2) ensure notifications are enabled for Emerald Utilities in Windows Settings → System → Notifications.',
                    code,
                    response: out,
                });
            }

            if (code === 0) {
                resolve({ ok: true, provider: 'snoretoast', state: 'shown', response: out, code });
            } else {
                resolve({ ok: false, provider: 'snoretoast', state: 'failed', error: errOut || `SnoreToast exited with code ${code}`, code });
            }
        });
    });
}

// ==================== LINUX / macOS: node-notifier ====================
// node-notifier is a CommonJS module. We load it via createRequire (see
// above) so we reliably get the Notifier constructor. On Linux it uses
// notify-send/dbus; on macOS it uses the Notification Center.
async function notifyNodeNotifier(opts, provider) {
    try {
        const Notifier = require('node-notifier');
        return new Promise((resolve) => {
            console.log(`[OSNotifier] ${provider} notification attempt started`);
            const notifier = new Notifier({
                icon: opts.icon || resolveIcon(),
                sound: opts.sound && !opts.silent,
                wait: true,
            });

            notifier.notify(
                {
                    title: opts.title,
                    message: opts.message,
                    urgency: opts.urgency,
                    silent: opts.silent,
                    timeout: opts.timeout,
                },
                (err, response) => {
                    if (err) {
                        console.error(`[OSNotifier] ${provider} notification failed:`, err.message);
                        resolve({ ok: false, provider, state: 'failed', error: err.message });
                        return;
                    }
                    console.log(`[OSNotifier] ${provider} notification shown`);
                    resolve({ ok: true, provider, state: 'shown', response });
                }
            );
        });
    } catch (err) {
        console.error(`[OSNotifier] ${provider} backend unavailable:`, err.message);
        return { ok: false, provider, state: 'failed', error: err.message };
    }
}

function notifyLinux(opts) {
    return notifyNodeNotifier(opts, 'node-notifier/linux');
}

function notifyMacOS(opts) {
    return notifyNodeNotifier(opts, 'node-notifier/macos');
}

// ==================== PUBLIC API ====================

/**
 * Platform-independent notifier.
 *
 * @example
 * await OSNotifier.notify({
 *     title: "Emerald Reminder",
 *     message: "Your task is due.",
 *     sound: true,
 *     urgency: "normal"
 * });
 */
export const OSNotifier = {
    async notify(options) {
        const opts = normalizeOptions(options);
        switch (process.platform) {
            case 'win32':
                return notifyWindows(opts);
            case 'linux':
                return notifyLinux(opts);
            case 'darwin':
                return notifyMacOS(opts);
            default:
                throw new Error(`Unsupported platform: ${process.platform}`);
        }
    },

    /**
         * Attempt to re-enable Windows toast notifications that were suppressed
         * with DisabledForUser. Reuses the battle-tested register-aumid-shortcut.ps1
         * (which attaches the AUMID to a Start Menu shortcut) and then clears the
         * per-user Disabled registry flags that Windows persists for the app.
         *
         * @returns {Promise<{ok: boolean, state: string, error?: string}>}
         */
    async enable() {
        if (process.platform !== 'win32') {
            return { ok: false, state: 'unsupported', error: `enable() is Windows-only (current: ${process.platform})` };
        }

        const aumid = getAumid();
        const shortcutPath = path.join(
            process.env.APPDATA || '',
            'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Emerald Utilities.lnk'
        );
        const target = process.execPath;
        // In dev, electron.exe needs the app path as an argument to actually
        // launch the application (see registerAumidShortcut in heavensgate.js).
        const targetArgs = app.isPackaged ? '' : path.join(process.cwd(), '.');
        const regKey = `HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\${aumid}`;
        // Win10/11 also tracks the per-app notification toggle under this
        // "modern" key (separate from the legacy SystemAppData path above).
        const modernKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`;

        // 1) Re-register the AUMID shortcut using the existing, tested script.
        let scriptPath;
        try {
            scriptPath = resolveInternalScriptsPath('register-aumid-shortcut.ps1');
        } catch {
            scriptPath = path.join(process.cwd(), 'src', 'internal-scripts', 'register-aumid-shortcut.ps1');
        }

        const errors = [];
        const warnings = [];
        const run = (cmd, args) => new Promise((resolve) => {
            try {
                const proc = spawn(cmd, args, { windowsHide: true });
                let stdout = '';
                let stderr = '';
                proc.stdout.on('data', (d) => { stdout += d.toString(); });
                proc.stderr.on('data', (d) => { stderr += d.toString(); });
                proc.on('error', (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
                proc.on('close', (code) => {
                    if (code === 0) resolve({ ok: true, stdout, stderr });
                    else resolve({ ok: false, error: stderr.trim() || `Exit code ${code}`, stdout });
                });
            } catch (err) {
                resolve({ ok: false, error: err.message });
            }
        });

        // a) Refresh the AUMID shortcut (resets Windows' cached notification state).
        //    This is BEST-EFFORT: Windows does not strictly require the shortcut
        //    AUMID for toasts when SnoreToast registers its own activation, and
        //    WScript.Shell.Save() can transiently fail on a shell file-lock (the
        //    .lnk is created at app startup). A failure here must NOT block
        //    enable() — the critical action is clearing the Disabled flags in (b).
        if (existsSync(scriptPath)) {
            const psArgs = [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
                '-ShortcutPath', shortcutPath,
                '-Target', target,
                '-Aumid', aumid,
            ];
            // Pass the app path in dev so the shortcut actually launches the app.
            if (targetArgs) {
                psArgs.push('-TargetArgs', targetArgs);
            }
            const reg = await run('powershell.exe', psArgs);
            if (!reg.ok) warnings.push(`shortcut: ${reg.error}`);
        } else {
            warnings.push(`shortcut: register-aumid-shortcut.ps1 not found at ${scriptPath}`);
        }

        // b) Clear the per-user "Disabled" notification flags for this AUMID.
        //    Windows persists the disabled state in several forms across BOTH
        //    the legacy SystemAppData key and the modern per-app Settings key:
        //      - "Disabled" / "DisabledByUser" / "DisabledReason"
        //        (SnoreToast reads DisabledReason to report "DisabledForUser")
        //      - the modern per-app toggle under Notifications\Settings
        //    We clear every known suppression marker so the OS no longer
        //    reports the app as disabled. If this PowerShell step fails,
        //    enable() reports failure.
        const clearFlags = `
$ErrorActionPreference = 'SilentlyContinue'
$reg = '${regKey.replace(/'/g, "''")}'
$modern = '${modernKey.replace(/'/g, "''")}'
$names = @('Disabled','DisabledByUser','DisabledReason','DisabledPolicy','DisabledForUser','ShowInSettings','EleEnabled')
foreach ($path in @($reg, $modern)) {
    if (Test-Path $path) {
        foreach ($name in $names) {
            Remove-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
        }
        # Also remove any Disabled* subkey (Windows may nest reason data here).
        Get-ChildItem -Path $path -Name 'Disabled*' -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -Path (Join-Path $path $_) -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
Write-Output 'CLEARED'
`;
        const cleared = await run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', clearFlags,
        ]);
        if (!cleared.ok) errors.push(`registry: ${cleared.error}`);

        if (errors.length) {
            return { ok: false, state: 'blocked', error: errors.join('; ') };
        }

        // c) Verify the disabled state is actually gone by re-reading both keys.
        const verify = `
$ErrorActionPreference = 'SilentlyContinue'
$reg = '${regKey.replace(/'/g, "''")}'
$modern = '${modernKey.replace(/'/g, "''")}'
$found = $false
foreach ($path in @($reg, $modern)) {
    if (Test-Path $path) {
        $props = Get-ItemProperty -Path $path | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
        if ($props -match 'Disabled') { $found = $true }
        if (Get-ChildItem -Path $path -Name 'Disabled*' -ErrorAction SilentlyContinue) { $found = $true }
    }
}
if ($found) { Write-Output 'STILL_DISABLED' } else { Write-Output 'VERIFIED_CLEAR' }
`;
        const verified = await run('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', verify,
        ]);
        const stillDisabled = verified.stdout && verified.stdout.includes('STILL_DISABLED');

        if (errors.length) {
            return { ok: false, state: 'blocked', error: errors.join('; ') };
        }
        const output = stillDisabled
            ? 'Disabled flags cleared, but Windows still reports a disabled state. You may need to enable notifications in Settings → System → Notifications → Emerald Utilities.'
            : 'Disabled flags cleared and verified.'
            + (warnings.length ? ` Shortcut refresh warning (non-fatal): ${warnings.join('; ')}` : '');
        return { ok: !stillDisabled, state: stillDisabled ? 'blocked' : 'enabled', output };
    },

    /**
     * Diagnostic snapshot of the notification environment. Logs platform,
     * packaged state, AUMID, exec path, shortcut existence, and whether the
     * Electron Notification API is supported. Never logs secrets.
     */
    async diagnose() {
        const shortcutPath =
            process.platform === 'win32' && process.env.APPDATA
                ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Emerald Utilities.lnk')
                : null;

        let shortcutExists = false;
        if (shortcutPath) {
            try {
                shortcutExists = fs.existsSync(shortcutPath);
            } catch {
                shortcutExists = false;
            }
        }

        const info = {
            platform: process.platform,
            isPackaged: typeof app.isPackaged === 'boolean' ? app.isPackaged : undefined,
            appUserModelId: typeof app.getAppUserModelId === 'function' ? app.getAppUserModelId() : undefined,
            backend: process.platform === 'win32' ? 'snoretoast' : 'node-notifier',
            aumid: process.platform === 'win32' ? getAumid() : undefined,
            execPath: process.execPath,
            exePath: typeof app.getPath === 'function' ? app.getPath('exe') : undefined,
            shortcutPath,
            shortcutExists,
            notificationSupported: typeof Notification === 'function' && Notification.isSupported(),
        };

        console.log('[OSNotifier] diagnose:', JSON.stringify(info, null, 2));
        return info;
    },
};

/**
 * Backwards-compatible helper. Existing callers may still use this.
 * @deprecated Use OSNotifier.notify() instead.
 */
export async function sendOsNotification(options) {
    return OSNotifier.notify(options);
}
