/**
 * Tasks JSON File Store — Local fallback when no database is available.
 *
 * Stores notes and tasks as JSON files in the app's userData directory.
 * Simple, no dependencies, works everywhere.
 *
 * All writes are atomic: write to .tmp, fsync, rename over target.
 * This prevents corruption if the process crashes mid-write.
 *
 * Supports both Electron and Node.js CLI contexts:
 *   - Electron: uses app.getPath('userData')
 *   - Node.js CLI: uses TASKS_JSON_DIR env var, or falls back to cwd/tasks-data
 */

import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, fdatasync, closeSync } from 'fs';

// Lazy-load electron app (only available in Electron main process)
let electronApp = null;
async function getElectronApp() {
    if (electronApp) return electronApp;
    try {
        const mod = await import('electron');
        electronApp = mod.app;
    } catch {
        // Not in Electron context
    }
    return electronApp;
}

function resolveDataDir() {
    // Environment variable override (for CLI / testing)
    if (process.env.TASKS_JSON_DIR) {
        return process.env.TASKS_JSON_DIR;
    }
    // In Electron, use userData; in Node.js, use cwd
    // This is resolved at call time because app may not be ready at import time
    return path.join(process.cwd(), 'tasks-data');
}

async function getDataDir() {
    const app = await getElectronApp();
    if (app && app.getPath) {
        return path.join(app.getPath('userData'), 'tasks-data');
    }
    return resolveDataDir();
}

let cachedDataDir = null;
let cachedNotesFile = null;
let cachedTasksFile = null;

async function getNotesFile() {
    if (cachedNotesFile) return cachedNotesFile;
    const dir = await getDataDir();
    cachedNotesFile = path.join(dir, 'notes.json');
    cachedDataDir = dir;
    return cachedNotesFile;
}

async function getTasksFile() {
    if (cachedTasksFile) return cachedTasksFile;
    const dir = await getDataDir();
    cachedTasksFile = path.join(dir, 'tasks.json');
    cachedDataDir = dir;
    return cachedTasksFile;
}

// Exported file paths (resolved asynchronously)
export const JSON_NOTES_FILE = getNotesFile();
export const JSON_TASKS_FILE = getTasksFile();

function ensureDataDir(dir) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

/**
 * Atomic JSON write:
 * 1. Write to a temporary file in the same directory
 * 2. fsync and close
 * 3. rename the temporary file over the target
 *
 * If the process crashes at any point, the previous valid JSON remains intact.
 */
function atomicWriteJson(filePath, data, dir) {
    ensureDataDir(dir);
    const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const json = JSON.stringify(data, null, 2);

    // Write to temp file
    writeFileSync(tmpPath, json, 'utf8');

    // fsync to ensure data is on disk
    let fd;
    try {
        fd = openSync(tmpPath, 'r+');
        fdatasync(fd);
    } finally {
        if (fd !== undefined) closeSync(fd);
    }

    // Atomic rename
    renameSync(tmpPath, filePath);
}

function readJson(filePath, fallback) {
    try {
        if (!existsSync(filePath)) return fallback;
        const raw = readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

// --- Notes ---
export async function getJsonNotes() {
    const filePath = await getNotesFile();
    return readJson(filePath, []);
}

export async function getJsonNoteById(id) {
    const notes = await getJsonNotes();
    return notes.find(n => n.id === id) || null;
}

export async function createJsonNote(note) {
    const filePath = await getNotesFile();
    const dir = path.dirname(filePath);
    const notes = await getJsonNotes();
    const newNote = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        date: note.date || new Date().toISOString().split('T')[0],
        content: note.content,
        archived: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    notes.unshift(newNote);
    atomicWriteJson(filePath, notes, dir);
    return newNote;
}

export async function updateJsonNote(id, updates) {
    const filePath = await getNotesFile();
    const dir = path.dirname(filePath);
    const notes = await getJsonNotes();
    const idx = notes.findIndex(n => n.id === id);
    if (idx === -1) return null;
    notes[idx] = { ...notes[idx], ...updates, updated_at: new Date().toISOString() };
    atomicWriteJson(filePath, notes, dir);
    return notes[idx];
}

export async function deleteJsonNote(id) {
    const filePath = await getNotesFile();
    const dir = path.dirname(filePath);
    const notes = await getJsonNotes();
    const filtered = notes.filter(n => n.id !== id);
    atomicWriteJson(filePath, filtered, dir);
    return { id };
}

// --- Tasks ---
export async function getJsonTasks() {
    const filePath = await getTasksFile();
    return readJson(filePath, []);
}

export async function getJsonTaskById(id) {
    const tasks = await getJsonTasks();
    return tasks.find(t => t.id === id) || null;
}

export async function createJsonTask(task) {
    const filePath = await getTasksFile();
    const dir = path.dirname(filePath);
    const tasks = await getJsonTasks();
    const newTask = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        title: task.title,
        description: task.description || null,
        completed: false,
        archived: false,
        priority: ['green', 'orange', 'red'].includes(task.priority) ? task.priority : 'green',
        due_time: task.due_time || null,
        reminder_time: task.reminder_time || null,
        long_term: Boolean(task.long_term),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    tasks.unshift(newTask);
    atomicWriteJson(filePath, tasks, dir);
    return newTask;
}

export async function updateJsonTask(id, updates) {
    const filePath = await getTasksFile();
    const dir = path.dirname(filePath);
    const tasks = await getJsonTasks();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;
    tasks[idx] = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() };
    atomicWriteJson(filePath, tasks, dir);
    return tasks[idx];
}

export async function deleteJsonTask(id) {
    const filePath = await getTasksFile();
    const dir = path.dirname(filePath);
    const tasks = await getJsonTasks();
    const filtered = tasks.filter(t => t.id !== id);
    atomicWriteJson(filePath, filtered, dir);
    return { id };
}

// --- Reminders ---
export async function getJsonPendingReminders() {
    const tasks = await getJsonTasks();
    const now = new Date().toISOString();
    return tasks.filter(t => !t.completed && t.reminder_time && t.reminder_time <= now);
}

export async function markJsonReminderHandled(id) {
    return updateJsonTask(id, { reminder_time: null });
}

// --- Bulk write (used by sync-tasks-data.js) ---
export async function writeJsonNotes(notes) {
    const filePath = await getNotesFile();
    const dir = path.dirname(filePath);
    atomicWriteJson(filePath, notes, dir);
}

export async function writeJsonTasks(tasks) {
    const filePath = await getTasksFile();
    const dir = path.dirname(filePath);
    atomicWriteJson(filePath, tasks, dir);
}
