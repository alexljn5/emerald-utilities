/**
 * AUMID (AppUserModelID) — single source of truth for Windows application
 * identity. Pure and Electron-free so it can be unit-tested under plain Node.
 *
 * Windows Toast notifications require the AUMID passed to the notifier
 * (SnoreToast `-appID`), the AUMID set via `app.setAppUserModelId()`, and the
 * AUMID attached to a registered Start Menu shortcut to ALL be IDENTICAL.
 *
 * We keep ONE source of truth that differs only by packaged state, so the
 * ENTIRE identity chain is internally consistent per context:
 *   dev  (unpackaged) → com.alexljn5.emeraldutilities.dev
 *   prod (packaged)   → com.alexljn5.emeraldutilities
 *
 * Never let "Electron AUMID A, Shortcut AUMID B, SnoreToast AUMID C" happen —
 * Windows toast registration becomes extremely unreliable when they disagree.
 */

export const APP_AUMID = 'com.alexljn5.emeraldutilities';
export const APP_AUMID_DEV = 'com.alexljn5.emeraldutilities.dev';

/**
 * Resolve the canonical AUMID for the given packaged state.
 *
 * @param {boolean} isPackaged - Whether the app is running in a packaged build.
 * @returns {string} The canonical AUMID for that environment.
 */
export function resolveAumid(isPackaged) {
    return isPackaged ? APP_AUMID : APP_AUMID_DEV;
}

/**
 * The set of all valid AUMIDs this app may use. Useful for validation and
 * tests to confirm values are never accidentally changed.
 */
export const VALID_AUMIDS = Object.freeze([APP_AUMID, APP_AUMID_DEV]);
