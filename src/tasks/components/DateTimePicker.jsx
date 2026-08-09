// src/tasks/components/DateTimePicker.jsx
// Custom styled date+time picker for due/reminder fields.
// Renders as a centered modal via portal so it is never clipped.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

export default function DateTimePicker({ value, onChange, placeholder }) {
    const [isOpen, setIsOpen] = useState(false);
    const [viewDate, setViewDate] = useState(() => {
        if (value) {
            const d = new Date(value);
            return new Date(d.getFullYear(), d.getMonth(), 1);
        }
        return new Date();
    });
    const [selectedTime, setSelectedTime] = useState(() => {
        if (value) {
            const d = new Date(value);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
        return '09:00';
    });

    useEffect(() => {
        function handleClickOutside(e) {
            // The modal is rendered via portal into document.body, so it lives
            // OUTSIDE .datetimePicker. Treat the trigger and the portaled modal
            // (overlay + its contents) as "inside" so a click on the calendar
            // does not close the picker before the day's click handler fires.
            if (e.target.closest('.datetimePicker')) return;
            if (e.target.closest('.datetimePickerModalOverlay')) return;
            setIsOpen(false);
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
            return () => { document.body.style.overflow = ''; };
        }
    }, [isOpen]);

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    const days = [];
    for (let i = firstDay - 1; i >= 0; i--) {
        days.push({ day: daysInPrevMonth - i, current: false });
    }
    for (let i = 1; i <= daysInMonth; i++) {
        days.push({ day: i, current: true });
    }
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
        days.push({ day: i, current: false });
    }

    const selectedDate = value ? new Date(value) : null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    function selectDate(day) {
        const date = new Date(year, month, day, parseInt(selectedTime.split(':')[0]), parseInt(selectedTime.split(':')[1]));
        const iso = date.toISOString();
        onChange(iso);
        setIsOpen(false);
    }

    // Sync selectedTime with value prop when value changes externally
    useEffect(() => {
        if (value) {
            const d = new Date(value);
            const newTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            if (newTime !== selectedTime) {
                setSelectedTime(newTime);
            }
        }
    }, [value]);

    function handleTimeChange(e) {
        const newTime = e.target.value;
        setSelectedTime(newTime);
        // Always update the value if we have one, or prepare for date selection
        if (value) {
            const d = new Date(value);
            const [hours, minutes] = newTime.split(':').map(Number);
            d.setHours(hours, minutes);
            onChange(d.toISOString());
        }
        // If no value yet, selectedTime is updated so selectDate uses it
    }

    function prevMonth() {
        setViewDate(new Date(year, month - 1, 1));
    }

    function nextMonth() {
        setViewDate(new Date(year, month + 1, 1));
    }

    function clearValue() {
        onChange('');
        setIsOpen(false);
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    return (
        <div className="datetimePicker">
            <button
                type="button"
                className={`datetimePickerTrigger ${value ? 'hasValue' : ''}`}
                onClick={() => setIsOpen(!isOpen)}
            >
                <span className="datetimePickerIcon">[ ]</span>
                <span className="datetimePickerText">
                    {value ? new Date(value).toLocaleString() : placeholder || 'Select date & time...'}
                </span>
                {value && (
                    <span className="datetimePickerClear" onClick={(e) => { e.stopPropagation(); clearValue(); }}>×</span>
                )}
            </button>

            {isOpen && createPortal(
                <div className="datetimePickerModalOverlay" onClick={() => setIsOpen(false)}>
                    <div className="datetimePickerModal" onClick={(e) => e.stopPropagation()}>
                        <div className="datetimePickerHeader">
                            <button type="button" className="datetimePickerNav" onClick={prevMonth}>‹</button>
                            <span className="datetimePickerMonth">
                                {monthNames[month]} {year}
                            </span>
                            <button type="button" className="datetimePickerNav" onClick={nextMonth}>›</button>
                        </div>

                        <div className="datetimePickerWeekdays">
                            {dayNames.map((d) => (
                                <span key={d}>{d}</span>
                            ))}
                        </div>

                        <div className="datetimePickerDays">
                            {days.map((d, i) => {
                                const date = new Date(year, month, d.day);
                                const isToday = d.current && date.getTime() === today.getTime();
                                const isSelected = d.current && selectedDate &&
                                    date.getDate() === selectedDate.getDate() &&
                                    date.getMonth() === selectedDate.getMonth() &&
                                    date.getFullYear() === selectedDate.getFullYear();

                                return (
                                    <button
                                        key={i}
                                        type="button"
                                        className={[
                                            'datetimePickerDay',
                                            d.current ? '' : 'otherMonth',
                                            isToday ? 'today' : '',
                                            isSelected ? 'selected' : '',
                                        ].filter(Boolean).join(' ')}
                                        onClick={() => d.current && selectDate(d.day)}
                                        disabled={!d.current}
                                    >
                                        {d.day}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="datetimePickerTime">
                            <label>Time</label>
                            <input
                                type="time"
                                value={selectedTime}
                                onChange={handleTimeChange}
                            />
                        </div>

                        <button type="button" className="datetimePickerModalClose" onClick={() => setIsOpen(false)}>Close</button>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
