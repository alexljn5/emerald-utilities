/**
 * Unit tests for the AUMID (AppUserModelID) identity resolution.
 *
 * Verifies that the Windows application identity chain resolves to the correct
 * AUMID for BOTH environments:
 *   dev  (unpackaged) → com.alexljn5.emeraldutilities.dev
 *   prod (packaged)   → com.alexljn5.emeraldutilities
 *
 * These are pure-logic tests (Electron-free) so they run under plain Node,
 * matching the project's unit-test conventions (see tests/README.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveAumid,
    APP_AUMID,
    APP_AUMID_DEV,
    VALID_AUMIDS,
} from '../../src/utils/aumid.js';

test('prod AUMID resolves for a packaged build', () => {
    assert.equal(resolveAumid(true), APP_AUMID);
    assert.equal(resolveAumid(true), 'com.alexljn5.emeraldutilities');
});

test('dev AUMID resolves for an unpackaged build', () => {
    assert.equal(resolveAumid(false), APP_AUMID_DEV);
    assert.equal(resolveAumid(false), 'com.alexljn5.emeraldutilities.dev');
});

test('prod and dev AUMIDs are distinct (never collide)', () => {
    assert.notEqual(APP_AUMID, APP_AUMID_DEV);
});

test('resolveAumid handles both explicit boolean states', () => {
    assert.equal(resolveAumid(true), 'com.alexljn5.emeraldutilities');
    assert.equal(resolveAumid(false), 'com.alexljn5.emeraldutilities.dev');
});

test('VALID_AUMIDS contains exactly the two canonical identities', () => {
    assert.deepEqual(
        [...VALID_AUMIDS].sort(),
        ['com.alexljn5.emeraldutilities', 'com.alexljn5.emeraldutilities.dev'].sort()
    );
});

test('VALID_AUMIDS is frozen (identity constants cannot drift)', () => {
    assert.ok(Object.isFrozen(VALID_AUMIDS));
});

test('dev AUMID is a suffix variant of the prod AUMID (correct dev tagging)', () => {
    assert.ok(APP_AUMID_DEV.endsWith('.dev'));
    assert.ok(APP_AUMID_DEV.startsWith(APP_AUMID + '.'));
});
