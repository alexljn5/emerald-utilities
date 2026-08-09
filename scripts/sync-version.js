#!/usr/bin/env node
/**
 * Sync version from globals.js to package.json
 * Run this script before building/publishing to update package.json version
 * 
 * Usage: node scripts/sync-version.js
 */

import fs from 'fs';
import path from 'path';

// Read version from globals.js
const globalsPath = path.join(import.meta.dirname, '..', 'src', 'globals.js');
const globalsContent = fs.readFileSync(globalsPath, 'utf8');
const versionMatch = globalsContent.match(/export const versionNumber = '([^']+)'/);

if (!versionMatch) {
    console.error('Could not find versionNumber in globals.js');
    process.exit(1);
}

const version = versionMatch[1];

// Read package.json
const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Update version if different
if (packageJson.version !== version) {
    packageJson.version = version;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`Updated package.json version to ${version}`);
} else {
    console.log(`package.json version already up to date: ${version}`);
}