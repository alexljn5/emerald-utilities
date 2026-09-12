// src/pages/Tasks.jsx
// Simple sticky-note style tasks page.
// No Kanban, no boards, no columns.

import { useState, useEffect, useCallback, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { invoke, on } from '../utils/electronApi.js';
import DateTimePicker from '../tasks/components/DateTimePicker.jsx';
import { formatDateTime } from '../utils/dateUtils.js';
import sigilLogo from '../../img/logos/alexljn5_logo_merge_transparent.png';
import '../css/tasks.css';

export default function Tasks({ route, setRoute }) {
    const [notes, setNotes] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [reminders, setReminders] = useState([]);
    const [connectionMode, setConnectionMode] = useState('unknown');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [activeView, setActiveView] = useState('tasks');
    const [selectedTask, setSelectedTask] = useState(null);
    const [selectedNote, setSelectedNote] = useState(null);
    const [editTask, setEditTask] = useState(null);   // editable task fields while modal open
    const [editNote, setEditNote] = useState(null);   // editable note fields while modal open
    const [deleteConfirm, setDeleteConfirm] = useState(null); // {type:'task'|'note', id, label, step:1|2}
    const [toasts, setToasts] = useState([]);
    const [showInAppNotifications, setShowInAppNotifications] = useState(true);
    const notifiedReminderIdsRef = useRef(new Set());

    // Form state
    const [noteContent, setNoteContent] = useState('');
    const [noteDate, setNoteDate] = useState(new Date().toISOString().split('T')[0]);
    const [taskTitle, setTaskTitle] = useState('');
    const [taskDescription, setTaskDescription] = useState('');
    const [taskPriority, setTaskPriority] = useState('green');
    const [taskDueTime, setTaskDueTime] = useState('');
    const [taskReminderTime, setTaskReminderTime] = useState('');
    const [taskNotificationPolicy, setTaskNotificationPolicy] = useState('daily');
    const [taskCustomInterval, setTaskCustomInterval] = useState(60);

    // Long-term form state
    const [longTermTitle, setLongTermTitle] = useState('');
    const [longTermDescription, setLongTermDescription] = useState('');
    const [longTermPriority, setLongTermPriority] = useState('green');

    async function showTaskNotification({ title, message, priority = 'green' }) {
        const urgency = priority === 'red' ? 'critical' : priority === 'orange' ? 'normal' : 'low';
        await invoke('tasks:notify', {
            title,
            body: message,
            urgency
        });
    }

    function applyReminderNotifications(nextReminders) {
        const fresh = nextReminders.filter(reminder => !notifiedReminderIdsRef.current.has(reminder.id));
        if (fresh.length === 0) return;

        fresh.forEach(reminder => {
            const parts = [reminder.title];
            if (reminder.due_time) parts.push(`Due: ${formatDateTime(reminder.due_time)}`);
            if (reminder.reminder_time) parts.push(`Reminder: ${formatDateTime(reminder.reminder_time)}`);
            showTaskNotification({
                title: 'Task Due',
                message: parts.join('\n'),
                priority: reminder.priority || 'green'
            }).catch(() => { });
        });

        fresh.forEach(reminder => notifiedReminderIdsRef.current.add(reminder.id));
    }

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const [notesRes, tasksRes, remindersRes, connRes] = await Promise.all([
                invoke('tasks:getNotes'),
                invoke('tasks:getTasks'),
                invoke('tasks:getPendingReminders'),
                invoke('tasks:getConnectionInfo'),
            ]);

            if (notesRes?.ok) setNotes(notesRes.notes || []);
            if (tasksRes?.ok) setTasks(tasksRes.tasks || []);
            if (remindersRes?.ok) {
                const nextReminders = remindersRes.reminders || [];
                setReminders(nextReminders);
                applyReminderNotifications(nextReminders);
            }
            if (connRes?.ok) setConnectionMode(connRes.mode || 'unknown');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();

        // Poll reminders every 30s
        const interval = setInterval(async () => {
            try {
                const res = await invoke('tasks:getPendingReminders');
                if (res?.ok) {
                    const nextReminders = res.reminders || [];
                    setReminders(nextReminders);
                    applyReminderNotifications(nextReminders);
                }
            } catch {
                // silent
            }
        }, 30000);

        return () => clearInterval(interval);
    }, [loadData]);

    // Listen for in-app notification toasts broadcast from the main process.
    useEffect(() => {
        const unsubscribe = on('tasks-toast', (toast) => {
            pushToast(toast);
        });
        return unsubscribe;
    }, []);

    // Load in-app notification setting and listen for changes.
    useEffect(() => {
        let cancelled = false;

        async function loadSetting() {
            try {
                const result = await invoke('settings:get');
                if (!cancelled && result?.ok && typeof result.ui?.showInAppNotifications === 'boolean') {
                    setShowInAppNotifications(result.ui.showInAppNotifications);
                }
            } catch {
                // keep default
            }
        }

        loadSetting();

        const unsubscribe = window.electronAPI?.on?.('settings-changed', (nextUi) => {
            if (!cancelled && typeof nextUi?.showInAppNotifications === 'boolean') {
                setShowInAppNotifications(nextUi.showInAppNotifications);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe?.();
        };
    }, []);

    // Add an in-app toast to the local list and auto-dismiss after 6s.
    function pushToast(toast) {
        setToasts((prev) => [...prev, toast]);
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== toast.id));
        }, 6000);
    }

    // --- Notes ---
    async function handleCreateNote(e) {
        e.preventDefault();
        if (!noteContent.trim()) return;

        const res = await invoke('tasks:createNote', {
            content: noteContent.trim(),
            date: noteDate,
        });

        if (res?.ok) {
            setNoteContent('');
            setNoteDate(new Date().toISOString().split('T')[0]);
            loadData();
        }
    }

    async function handleDeleteNote(id) {
        await invoke('tasks:deleteNote', { id });
        loadData();
    }

    async function handleArchiveNote(id, archived = true) {
        await invoke('tasks:updateNote', {
            id,
            updates: { archived },
        });
        loadData();
    }

    // --- Tasks ---
    async function handleCreateTask(e) {
        e.preventDefault();
        if (!taskTitle.trim()) return;

        const res = await invoke('tasks:createTask', {
            title: taskTitle.trim(),
            description: taskDescription.trim() || null,
            priority: taskPriority,
            due_time: taskDueTime || null,
            reminder_time: taskReminderTime || null,
            notification_policy: taskNotificationPolicy,
            custom_interval_minutes: taskCustomInterval,
        });

        if (res?.ok) {
            setTaskTitle('');
            setTaskDescription('');
            setTaskPriority('green');
            setTaskDueTime('');
            setTaskReminderTime('');
            setTaskNotificationPolicy('daily');
            setTaskCustomInterval(60);
            loadData();
        }
    }

    async function handleToggleTask(id, completed, longTerm) {
        // If a long-term item is being checked off as done, also send it to
        // the archive (restorable from Archive view for safety).
        const updates = { completed: !completed };
        if (longTerm && !completed) {
            updates.archived = true;
        }
        await invoke('tasks:updateTask', {
            id,
            updates,
        });
        loadData();
    }

    async function handleDeleteTask(id) {
        await invoke('tasks:deleteTask', { id });
        loadData();
    }

    function requestDeleteTask(task) {
        setDeleteConfirm({ type: 'task', id: task.id, label: task.title, step: 1 });
    }

    function requestDeleteNote(note) {
        setDeleteConfirm({ type: 'note', id: note.id, label: note.content.slice(0, 60), step: 1 });
    }

    // Two-step permanent delete confirmation for safety.
    function advanceDeleteStep() {
        if (!deleteConfirm) return;
        if (deleteConfirm.step === 1) {
            setDeleteConfirm({ ...deleteConfirm, step: 2 });
        } else {
            confirmDelete();
        }
    }

    async function confirmDelete() {
        if (!deleteConfirm) return;
        if (deleteConfirm.type === 'task') {
            await handleDeleteTask(deleteConfirm.id);
        } else if (deleteConfirm.type === 'note') {
            await handleDeleteNote(deleteConfirm.id);
        }
        setDeleteConfirm(null);
    }

    async function handleArchiveTask(id, archived = true) {
        await invoke('tasks:updateTask', {
            id,
            updates: { archived },
        });
        loadData();
    }

    // --- Long-term ---
    async function handleCreateLongTerm(e) {
        e.preventDefault();
        if (!longTermTitle.trim()) return;

        const res = await invoke('tasks:createTask', {
            title: longTermTitle.trim(),
            description: longTermDescription.trim() || null,
            priority: longTermPriority,
            long_term: true,
        });

        if (res?.ok) {
            setLongTermTitle('');
            setLongTermDescription('');
            setLongTermPriority('green');
            loadData();
        }
    }

    async function handleMarkReminderHandled(id) {
        await invoke('tasks:markReminderHandled', { id });
        loadData();
    }

    // Single general-purpose debug notification control.
    async function handleDebugNotification() {
        try {
            const res = await invoke('tasks:notify:debug');
            const r = res?.result;
            if (r?.ok) {
                pushToast({
                    id: `debug-${Date.now().toString(36)}`,
                    title: 'Debug Notification Sent',
                    body: `State: ${r.state} (${r.provider})`,
                    urgency: 'normal',
                });
            }
        } catch (err) {
            console.warn('[Tasks] Debug notify invoke failed:', err.message);
        }
    }

    // Compact task-notification test controls (developer-only).
    // These use the exact same notification-generation code as real task
    // notifications, but target a specific task and type for testing.
    async function handleTestTaskNotification(type) {
        if (!selectedTask) {
            console.warn('[Tasks] Test notification skipped: no task selected');
            return;
        }
        try {
            const res = await invoke(`tasks:notify:test-${type}`, {
                taskId: selectedTask.id,
                title: selectedTask.title,
            });
            const r = res?.result;
            if (r?.ok) {
                const typeLabel = type === 'reminder' ? 'Reminder' : type === 'due' ? 'Due date' : 'Priority';
                const priority = selectedTask.priority || 'green';
                pushToast({
                    id: `test-${type}-${Date.now().toString(36)}`,
                    title: `${typeLabel} Test Sent`,
                    body: `State: ${r.state} (${r.provider}) | Priority: ${priority}`,
                    urgency: priority,
                });
            }
        } catch (err) {
            console.warn(`[Tasks] Test ${type} notify invoke failed:`, err.message);
        }
    }

    // --- Edit modal helpers ---
    function openTaskModal(task) {
        setSelectedTask(task);
        setEditTask({
            title: task.title || '',
            description: task.description || '',
            priority: task.priority || 'green',
            due_time: task.due_time || '',
            reminder_time: task.reminder_time || '',
            notification_policy: task.notification_policy || 'daily',
            custom_interval_minutes: task.custom_interval_minutes || 60,
        });
    }

    function openNoteModal(note) {
        setSelectedNote(note);
        setEditNote({
            date: note.date || '',
            content: note.content || '',
        });
    }

    async function handleSaveTask() {
        if (!selectedTask || !editTask) return;
        await invoke('tasks:updateTask', {
            id: selectedTask.id,
            updates: {
                title: editTask.title,
                description: editTask.description || null,
                priority: editTask.priority,
                due_time: editTask.due_time || null,
                reminder_time: editTask.reminder_time || null,
                notification_policy: editTask.notification_policy,
                custom_interval_minutes: editTask.custom_interval_minutes,
            },
        });
        setSelectedTask(null);
        setEditTask(null);
        loadData();
    }

    async function handleSaveNote() {
        if (!selectedNote || !editNote) return;
        await invoke('tasks:updateNote', {
            id: selectedNote.id,
            updates: {
                date: editNote.date,
                content: editNote.content,
            },
        });
        setSelectedNote(null);
        setEditNote(null);
        loadData();
    }

    const connectionLabel = connectionMode === 'database' ? 'Connected' : connectionMode === 'recovery' ? 'Recovery (JSON)' : connectionMode === 'degraded' ? 'Degraded' : 'Disconnected';
    const connectionClass = connectionMode === 'database' ? 'chStatusConnected' : connectionMode === 'recovery' ? 'chStatusWarning' : connectionMode === 'degraded' ? 'chStatusWarning' : 'chStatusError';
    const activeNotes = notes.filter(note => !note.archived);
    const archivedNotes = notes.filter(note => note.archived);
    const activeTasks = tasks.filter(task => !task.archived && !task.long_term);
    const archivedTasks = tasks.filter(task => task.archived);
    const openTasks = activeTasks.filter(task => !task.completed);
    const doneTasks = activeTasks.filter(task => task.completed);
    const longTermTasks = tasks.filter(task => task.long_term && !task.archived);

    const sidebar = (
        <>
            <div className="chPanel connectionPanel">
                <h3>Status</h3>
                <span className={`chStatusBadge ${connectionClass}`}>{connectionLabel}</span>
            </div>
            <div className="sidebarCards">
                <div className="chPanel sidebarCard">
                    <h3>Notes</h3>
                    <span className="sidebarCount">{activeNotes.length}</span>
                </div>
                <div className="chPanel sidebarCard">
                    <h3>Tasks</h3>
                    <span className="sidebarCount">{openTasks.length}</span>
                </div>
                <div className="chPanel sidebarCard">
                    <h3>Long-term</h3>
                    <span className="sidebarCount">{longTermTasks.length}</span>
                </div>
                <div className="chPanel sidebarCard">
                    <h3>Pending</h3>
                    <span className="sidebarCount">{reminders.length}</span>
                </div>
                <div className="chPanel sidebarCard">
                    <h3>Archive</h3>
                    <span className="sidebarCount">{archivedTasks.length + archivedNotes.length}</span>
                </div>
            </div>
        </>
    );

    if (loading && notes.length === 0 && tasks.length === 0) {
        return (
            <PageShell title="Tasks" route={route} setRoute={setRoute} leftChildren={sidebar}>
                <div className="chPanel">
                    <p>Loading tasks...</p>
                </div>
            </PageShell>
        );
    }

    return (
        <PageShell title="Tasks" route={route} setRoute={setRoute} leftChildren={sidebar}>
            {error && (
                <div className="chCharWarning--error">
                    {error}
                </div>
            )}

            {showInAppNotifications && toasts.length > 0 && (
                <div className="taskToastOverlay">
                    {toasts.map((t) => (
                        <div key={t.id} className={`taskToast taskToast-${t.urgency || 'normal'}`}>
                            <img
                                className="taskToastIcon"
                                src={sigilLogo}
                                alt=""
                                aria-hidden="true"
                            />
                            <div className="taskToastContent">
                                <strong>{t.title}</strong>
                                <span>{t.body}</span>
                            </div>
                            <button
                                type="button"
                                className="taskToastDismiss"
                                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="tasksPageBody">
                <nav className="tasksTopBar" aria-label="Task views">
                    <button type="button" className={activeView === 'notes' ? 'active' : ''} onClick={() => setActiveView('notes')}>Notes</button>
                    <button type="button" className={activeView === 'tasks' ? 'active' : ''} onClick={() => setActiveView('tasks')}>Tasks</button>
                    <button type="button" className={activeView === 'longterm' ? 'active' : ''} onClick={() => setActiveView('longterm')}>Long-term</button>
                    <button type="button" className={activeView === 'pending' ? 'active' : ''} onClick={() => setActiveView('pending')}>Pending</button>
                    <button type="button" className={activeView === 'archive' ? 'active' : ''} onClick={() => setActiveView('archive')}>Archive</button>
                    <button type="button" onClick={handleDebugNotification}>Debug Notification</button>
                </nav>

                {/* Tasks view — split layout */}
                {activeView === 'tasks' && (
                    <section className="tasksSplitLayout">
                        <div className="tasksSplitForm">
                            <h2>New Task</h2>
                            <form className="tasksForm" onSubmit={handleCreateTask}>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="taskTitle">Title</label>
                                    <input
                                        id="taskTitle"
                                        type="text"
                                        className="chInput"
                                        value={taskTitle}
                                        onChange={(e) => setTaskTitle(e.target.value)}
                                        placeholder="Task title..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="taskDescription">Description</label>
                                    <textarea
                                        id="taskDescription"
                                        className="chTextarea"
                                        rows={3}
                                        value={taskDescription}
                                        onChange={(e) => setTaskDescription(e.target.value)}
                                        placeholder="Optional description..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="taskPriority">Priority</label>
                                    <select
                                        id="taskPriority"
                                        className="chSelect"
                                        value={taskPriority}
                                        onChange={(e) => setTaskPriority(e.target.value)}
                                    >
                                        <option value="green">Green</option>
                                        <option value="orange">Orange</option>
                                        <option value="red">Red</option>
                                    </select>
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel">Due</label>
                                    <DateTimePicker
                                        value={taskDueTime}
                                        onChange={setTaskDueTime}
                                        placeholder="Select due date..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel">Reminder</label>
                                    <DateTimePicker
                                        value={taskReminderTime}
                                        onChange={setTaskReminderTime}
                                        placeholder="Select reminder..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="taskNotificationPolicy">Notification policy</label>
                                    <select
                                        id="taskNotificationPolicy"
                                        className="chSelect"
                                        value={taskNotificationPolicy}
                                        onChange={(e) => setTaskNotificationPolicy(e.target.value)}
                                    >
                                        <option value="none">None</option>
                                        <option value="once">Once</option>
                                        <option value="daily">Daily</option>
                                        <option value="weekly">Weekly</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                </div>
                                {taskNotificationPolicy === 'custom' && (
                                    <div className="chFormGroup">
                                        <label className="chLabel" htmlFor="taskCustomInterval">Custom interval (minutes)</label>
                                        <input
                                            id="taskCustomInterval"
                                            type="number"
                                            className="chInput"
                                            value={taskCustomInterval}
                                            onChange={(e) => setTaskCustomInterval(parseInt(e.target.value, 10) || 60)}
                                            min="1"
                                        />
                                    </div>
                                )}
                                <button type="submit" className="chButton chButtonPrimary">Add Task</button>
                            </form>
                        </div>
                        <div className="tasksSplitList">
                            <h2>All Tasks</h2>
                            <div className="tasksScrollArea">
                                <ul className="tasksList">
                                    {[...openTasks, ...doneTasks].map((task) => (
                                        <li
                                            key={task.id}
                                            className={`taskItem taskItemClickable taskPriority-${task.priority || 'green'} ${task.completed ? 'taskCompleted' : ''}`}
                                            onClick={() => openTaskModal(task)}
                                        >
                                            <label className="taskCheckbox" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={task.completed}
                                                    onChange={() => handleToggleTask(task.id, task.completed, false)}
                                                />
                                                <span className="taskTitle">{task.title}</span>
                                            </label>
                                            {task.description && <p className="taskDescription">{task.description}</p>}
                                            <div className="taskMeta">
                                                <span className="taskPriorityLabel">{task.priority || 'green'}</span>
                                                {task.due_time && (
                                                    <span className="taskDue">
                                                        Due: {formatDateTime(task.due_time)}
                                                    </span>
                                                )}
                                                {task.reminder_time && (
                                                    <span className="taskReminder">
                                                        Reminder: {formatDateTime(task.reminder_time)}
                                                    </span>
                                                )}
                                                {task.notification_policy && task.notification_policy !== 'daily' && (
                                                    <span className="taskPolicy">
                                                        Policy: {task.notification_policy}
                                                        {task.notification_policy === 'custom' && task.custom_interval_minutes ? ` (${task.custom_interval_minutes}m)` : ''}
                                                    </span>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                    {activeTasks.length === 0 && <p className="emptyState">No active tasks yet.</p>}
                                </ul>
                            </div>
                        </div>
                    </section>
                )}

                {activeView === 'notes' && (
                    <section className="tasksSplitLayout">
                        <div className="tasksSplitForm">
                            <h2>New Note</h2>
                            <form className="tasksForm" onSubmit={handleCreateNote}>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="noteDateAll">Date</label>
                                    <input
                                        id="noteDateAll"
                                        type="date"
                                        className="chInput"
                                        value={noteDate}
                                        onChange={(e) => setNoteDate(e.target.value)}
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="noteContentAll">Content</label>
                                    <textarea
                                        id="noteContentAll"
                                        className="chTextarea"
                                        rows={5}
                                        value={noteContent}
                                        onChange={(e) => setNoteContent(e.target.value)}
                                        placeholder="Quick note..."
                                    />
                                </div>
                                <button type="submit" className="chButton chButtonPrimary">Add Note</button>
                            </form>
                        </div>
                        <div className="tasksSplitList">
                            <h2>All Notes</h2>
                            <div className="tasksScrollArea">
                                <ul className="notesList">
                                    {activeNotes.map((note) => (
                                        <li key={note.id} className="noteItem noteItemClickable" onClick={() => openNoteModal(note)}>
                                            <div className="noteHeader">
                                                <span className="noteDate">{String(note.date)}</span>
                                            </div>
                                            <p className="noteContent">{note.content}</p>
                                        </li>
                                    ))}
                                    {activeNotes.length === 0 && <p className="emptyState">No notes yet.</p>}
                                </ul>
                            </div>
                        </div>
                    </section>
                )}

                {activeView === 'longterm' && (
                    <section className="tasksSplitLayout">
                        <div className="tasksSplitForm longTermForm">
                            <h2>New Long-term <span className="taskLongTermBadge">Storage</span></h2>
                            <form className="tasksForm" onSubmit={handleCreateLongTerm}>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="longTermTitle">Title</label>
                                    <input
                                        id="longTermTitle"
                                        type="text"
                                        className="chInput"
                                        value={longTermTitle}
                                        onChange={(e) => setLongTermTitle(e.target.value)}
                                        placeholder="Long-term item title..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="longTermDescription">Description</label>
                                    <textarea
                                        id="longTermDescription"
                                        className="chTextarea"
                                        rows={3}
                                        value={longTermDescription}
                                        onChange={(e) => setLongTermDescription(e.target.value)}
                                        placeholder="Optional description..."
                                    />
                                </div>
                                <div className="chFormGroup">
                                    <label className="chLabel" htmlFor="longTermPriority">Priority</label>
                                    <select
                                        id="longTermPriority"
                                        className="chSelect"
                                        value={longTermPriority}
                                        onChange={(e) => setLongTermPriority(e.target.value)}
                                    >
                                        <option value="green">Green</option>
                                        <option value="orange">Orange</option>
                                        <option value="red">Red</option>
                                    </select>
                                </div>
                                <button type="submit" className="chButton chButtonPrimary">Add Long-term Item</button>
                            </form>
                        </div>
                        <div className="tasksSplitList">
                            <h2>All Long-term Items</h2>
                            <div className="tasksScrollArea">
                                <ul className="tasksList">
                                    {longTermTasks.map((task) => (
                                        <li
                                            key={task.id}
                                            className={`taskItem taskItemClickable taskPriority-${task.priority || 'green'} ${task.completed ? 'taskCompleted' : ''}`}
                                            onClick={() => openTaskModal(task)}
                                        >
                                            <label className="taskCheckbox" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    checked={task.completed}
                                                    onChange={() => handleToggleTask(task.id, task.completed, true)}
                                                />
                                                <span className="taskTitle">{task.title}</span>
                                            </label>
                                            {task.description && <p className="taskDescription">{task.description}</p>}
                                            <div className="taskMeta">
                                                <span className="taskPriorityLabel">{task.priority || 'green'}</span>
                                                {task.due_time && (
                                                    <span className="taskDue">
                                                        Due: {formatDateTime(task.due_time)}
                                                    </span>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                    {longTermTasks.length === 0 && <p className="emptyState">No long-term items yet.</p>}
                                </ul>
                            </div>
                        </div>
                    </section>
                )}

                {activeView === 'pending' && (
                    <section className="tasksPanel tasksSinglePanel">
                        <h2>Pending Reminders</h2>
                        <div className="tasksScrollArea">
                            <ul className="remindersList">
                                {reminders.map((r) => (
                                    <li key={r.id} className={`reminderItem taskPriority-${r.priority || 'green'}`}>
                                        <span className="reminderTitle">{r.title}</span>
                                        <span className="reminderTime">
                                            {r.reminder_time ? formatDateTime(r.reminder_time) : ''}
                                        </span>
                                        <button
                                            type="button"
                                            className="chButton chButtonSmall"
                                            onClick={() => handleMarkReminderHandled(r.id)}
                                        >
                                            Done
                                        </button>
                                    </li>
                                ))}
                                {reminders.length === 0 && <p className="emptyState">No pending reminders.</p>}
                            </ul>
                        </div>
                    </section>
                )}

                {activeView === 'archive' && (
                    <section className="tasksPanel tasksSinglePanel">
                        <h2>Archive</h2>
                        <div className="tasksScrollArea">
                            <h3 className="archiveGroupTitle">Notes</h3>
                            <ul className="notesList">
                                {archivedNotes.map((note) => (
                                    <li key={note.id} className="noteItem noteItemClickable" onClick={() => openNoteModal(note)}>
                                        <div className="noteHeader">
                                            <span className="noteDate">{String(note.date)}</span>
                                        </div>
                                        <p className="noteContent">{note.content}</p>
                                        <div className="taskItemActions">
                                            <button
                                                type="button"
                                                className="chButton chButtonSmall"
                                                onClick={(e) => { e.stopPropagation(); handleArchiveNote(note.id, false); }}
                                            >
                                                Restore
                                            </button>
                                            <button
                                                type="button"
                                                className="chButton chButtonDanger chButtonSmall"
                                                onClick={(e) => { e.stopPropagation(); requestDeleteNote(note); }}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </li>
                                ))}
                                {archivedNotes.length === 0 && <p className="emptyState">No archived notes.</p>}
                            </ul>
                            <h3 className="archiveGroupTitle">Tasks</h3>
                            <ul className="tasksList">
                                {archivedTasks.map((task) => (
                                    <li key={task.id} className={`taskItem taskItemClickable taskPriority-${task.priority || 'green'}`} onClick={() => openTaskModal(task)}>
                                        <span className="taskTitle">{task.title}</span>
                                        {task.description && <p className="taskDescription">{task.description}</p>}
                                        <div className="taskMeta">
                                            <span className="taskPriorityLabel">{task.priority || 'green'}</span>
                                        </div>
                                        <div className="taskItemActions">
                                            <button
                                                type="button"
                                                className="chButton chButtonSmall"
                                                onClick={(e) => { e.stopPropagation(); handleArchiveTask(task.id, false); }}
                                            >
                                                Restore
                                            </button>
                                            <button
                                                type="button"
                                                className="chButton chButtonDanger chButtonSmall"
                                                onClick={(e) => { e.stopPropagation(); requestDeleteTask(task); }}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </li>
                                ))}
                                {archivedTasks.length === 0 && <p className="emptyState">No archived tasks.</p>}
                            </ul>
                        </div>
                    </section>
                )}

                {/* Task detail modal */}
                {selectedTask && editTask && (
                    <div className="taskDetailOverlay" onClick={() => { setSelectedTask(null); setEditTask(null); }}>
                        <div className="taskDetailModal" onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                className="taskDetailClose"
                                onClick={() => { setSelectedTask(null); setEditTask(null); }}
                            >
                                ×
                            </button>
                            <h2 className="taskDetailTitle">Edit Task</h2>
                            <div className="chFormGroup">
                                <label className="chLabel">Title</label>
                                <input
                                    type="text"
                                    className="chInput"
                                    value={editTask.title}
                                    onChange={(e) => setEditTask({ ...editTask, title: e.target.value })}
                                />
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Description</label>
                                <textarea
                                    className="chTextarea"
                                    rows={3}
                                    value={editTask.description}
                                    onChange={(e) => setEditTask({ ...editTask, description: e.target.value })}
                                />
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Priority</label>
                                <select
                                    className="chSelect"
                                    value={editTask.priority}
                                    onChange={(e) => setEditTask({ ...editTask, priority: e.target.value })}
                                >
                                    <option value="green">Green</option>
                                    <option value="orange">Orange</option>
                                    <option value="red">Red</option>
                                </select>
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Due</label>
                                <DateTimePicker
                                    value={editTask.due_time}
                                    onChange={(v) => setEditTask({ ...editTask, due_time: v })}
                                    placeholder="Select due date..."
                                />
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Reminder</label>
                                <DateTimePicker
                                    value={editTask.reminder_time}
                                    onChange={(v) => setEditTask({ ...editTask, reminder_time: v })}
                                    placeholder="Select reminder..."
                                />
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Notification policy</label>
                                <select
                                    className="chSelect"
                                    value={editTask.notification_policy || 'daily'}
                                    onChange={(e) => setEditTask({ ...editTask, notification_policy: e.target.value })}
                                >
                                    <option value="none">None</option>
                                    <option value="once">Once</option>
                                    <option value="daily">Daily</option>
                                    <option value="weekly">Weekly</option>
                                    <option value="custom">Custom</option>
                                </select>
                            </div>
                            {editTask.notification_policy === 'custom' && (
                                <div className="chFormGroup">
                                    <label className="chLabel">Custom interval (minutes)</label>
                                    <input
                                        type="number"
                                        className="chInput"
                                        value={editTask.custom_interval_minutes || 60}
                                        onChange={(e) => setEditTask({ ...editTask, custom_interval_minutes: parseInt(e.target.value, 10) || 60 })}
                                        min="1"
                                    />
                                </div>
                            )}
                            <div className="taskDetailMeta">
                                {selectedTask.created_at && (
                                    <p>Created: {formatDateTime(selectedTask.created_at)}</p>
                                )}
                                <p>Status: {selectedTask.completed ? 'Completed' : 'Open'}</p>
                                <p>{selectedTask.long_term ? 'Long-term item' : 'Task'}</p>
                            </div>
                            <button
                                type="button"
                                className="chButton chButtonPrimary"
                                onClick={handleSaveTask}
                            >
                                Save
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonSmall"
                                onClick={() => { handleToggleTask(selectedTask.id, selectedTask.completed, selectedTask.long_term); setSelectedTask(null); setEditTask(null); }}
                            >
                                {selectedTask.completed ? 'Reopen' : 'Mark Complete'}
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonSmall"
                                onClick={() => { handleArchiveTask(selectedTask.id, true); setSelectedTask(null); setEditTask(null); }}
                            >
                                Archive
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonDanger chButtonSmall"
                                onClick={() => requestDeleteTask(selectedTask)}
                            >
                                Delete
                            </button>
                            {/* Developer-only notification test controls */}
                            <div className="taskNotificationTests">
                                <span className="taskNotificationTestsLabel">Test notifications:</span>
                                <button
                                    type="button"
                                    className="chButton chButtonSmall chButtonTest"
                                    onClick={() => handleTestTaskNotification('reminder')}
                                    title="Send a test reminder notification for this task"
                                >
                                    Test Reminder
                                </button>
                                <button
                                    type="button"
                                    className="chButton chButtonSmall chButtonTest"
                                    onClick={() => handleTestTaskNotification('due')}
                                    title="Send a test due-date notification for this task"
                                >
                                    Test Due
                                </button>
                                <button
                                    type="button"
                                    className="chButton chButtonSmall chButtonTest chButtonTestPriority"
                                    onClick={() => handleTestTaskNotification('priority')}
                                    title="Send a test priority notification for this task"
                                >
                                    Test Priority
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Note detail modal (editable) */}
                {selectedNote && editNote && (
                    <div className="taskDetailOverlay" onClick={() => { setSelectedNote(null); setEditNote(null); }}>
                        <div className="taskDetailModal" onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                className="taskDetailClose"
                                onClick={() => { setSelectedNote(null); setEditNote(null); }}
                            >
                                ×
                            </button>
                            <h2 className="taskDetailTitle">Edit Note</h2>
                            <div className="chFormGroup">
                                <label className="chLabel">Date</label>
                                <input
                                    type="date"
                                    className="chInput"
                                    value={editNote.date}
                                    onChange={(e) => setEditNote({ ...editNote, date: e.target.value })}
                                />
                            </div>
                            <div className="chFormGroup">
                                <label className="chLabel">Content</label>
                                <textarea
                                    className="chTextarea"
                                    rows={6}
                                    value={editNote.content}
                                    onChange={(e) => setEditNote({ ...editNote, content: e.target.value })}
                                />
                            </div>
                            <div className="taskDetailMeta">
                                {selectedNote.created_at && (
                                    <p>Created: {formatDateTime(selectedNote.created_at)}</p>
                                )}
                                {selectedNote.updated_at && (
                                    <p>Updated: {formatDateTime(selectedNote.updated_at)}</p>
                                )}
                                <p>{selectedNote.archived ? 'Archived' : 'Active'}</p>
                            </div>
                            <button
                                type="button"
                                className="chButton chButtonPrimary"
                                onClick={handleSaveNote}
                            >
                                Save
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonSmall"
                                onClick={() => { handleArchiveNote(selectedNote.id, !selectedNote.archived); setSelectedNote(null); setEditNote(null); }}
                            >
                                {selectedNote.archived ? 'Restore' : 'Archive'}
                            </button>
                            <button
                                type="button"
                                className="chButton chButtonDanger chButtonSmall"
                                onClick={() => requestDeleteNote(selectedNote)}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                )}

                {/* Delete confirmation modal — two-step permanent delete */}
                {deleteConfirm && (
                    <div className="taskDetailOverlay" onClick={() => setDeleteConfirm(null)}>
                        <div className="taskDetailModal" onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                className="taskDetailClose"
                                onClick={() => setDeleteConfirm(null)}
                            >
                                ×
                            </button>
                            {deleteConfirm.step === 1 ? (
                                <>
                                    <h2 className="taskDetailTitle">Delete {deleteConfirm.type}?</h2>
                                    <p className="taskDetailDescription">
                                        You are about to delete this {deleteConfirm.type}.
                                    </p>
                                    <p className="taskDetailPriority">"{deleteConfirm.label}"</p>
                                    <div className="confirmActions">
                                        <button
                                            type="button"
                                            className="chButton chButtonPrimary"
                                            onClick={advanceDeleteStep}
                                        >
                                            Continue
                                        </button>
                                        <button
                                            type="button"
                                            className="chButton chButtonSmall"
                                            onClick={() => setDeleteConfirm(null)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <h2 className="taskDetailTitle">Confirm Permanent Delete</h2>
                                    <p className="taskDetailDescription">
                                        This will permanently delete the {deleteConfirm.type} and cannot be undone.
                                    </p>
                                    <p className="taskDetailPriority">"{deleteConfirm.label}"</p>
                                    <div className="confirmActions">
                                        <button
                                            type="button"
                                            className="chButton chButtonDanger"
                                            onClick={confirmDelete}
                                        >
                                            Delete Permanently
                                        </button>
                                        <button
                                            type="button"
                                            className="chButton chButtonSmall"
                                            onClick={() => setDeleteConfirm(null)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </PageShell>
    );
}

