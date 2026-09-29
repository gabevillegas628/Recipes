import { useState, type FormEvent, type ReactNode } from 'react';
import { WEEKDAYS, weekdayOf, type Freq, type Weekday } from '../../../server/src/recurrence';
import { imageUrl } from '../api';
import { monthlyPositions, type NoteValues, type RepeatValues } from '../notes';
import type { NoteKind } from '../types';

const KINDS: { kind: NoteKind; label: string }[] = [
  { kind: 'APPOINTMENT', label: 'Appointment' },
  { kind: 'REMINDER', label: 'Reminder' },
  { kind: 'NOTE', label: 'Note' },
];

/** Edits a note, reminder or appointment. The fields shown follow the kind. */
export function NoteForm({
  initial,
  image,
  onRemoveImage,
  saving,
  error,
  submitLabel = 'Save',
  onSubmit,
  onCancel,
  footer,
}: {
  initial: NoteValues;
  image?: string | null;
  onRemoveImage?: () => void;
  saving: boolean;
  error?: Error | null;
  submitLabel?: string;
  onSubmit: (values: NoteValues) => void;
  onCancel?: () => void;
  footer?: ReactNode;
}) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof NoteValues>(key: K, value: NoteValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const photo = imageUrl(image ?? null);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(v);
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="segmented">
        {KINDS.map((k) => (
          <button key={k.kind} type="button" className={v.kind === k.kind ? 'on' : ''} onClick={() => set('kind', k.kind)}>
            {k.label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Title</span>
        <input value={v.title} onChange={(e) => set('title', e.target.value)} required />
      </label>

      {v.kind !== 'NOTE' && (
        <>
          <div className="field-row field-row-2">
            <label className="field">
              <span>{v.kind === 'REMINDER' ? 'Due' : 'Date'}</span>
              <input
                type="date"
                value={v.date}
                onChange={(e) => set('date', e.target.value)}
                required={v.kind === 'APPOINTMENT'}
              />
            </label>
            <label className="field">
              <span>Time</span>
              <input type="time" value={v.time} onChange={(e) => set('time', e.target.value)} disabled={!v.date} />
            </label>
          </div>
          {v.kind === 'APPOINTMENT' && (
            <div className="field-row field-row-2">
              <label className="field">
                <span>Ends</span>
                <input type="time" value={v.endTime} onChange={(e) => set('endTime', e.target.value)} disabled={!v.time} />
              </label>
              <label className="field">
                <span>End date</span>
                <input
                  type="date"
                  value={v.endDate}
                  min={v.date}
                  onChange={(e) => set('endDate', e.target.value)}
                  disabled={!v.date}
                />
              </label>
            </div>
          )}
          <small className="muted field-hint">
            {v.kind === 'APPOINTMENT' ? 'Leave the time empty for all day.' : 'Leave empty for no due date.'}
          </small>
          {v.date && <RepeatFields date={v.date} value={v.repeat} onChange={(repeat) => set('repeat', repeat)} />}
        </>
      )}

      {v.kind === 'APPOINTMENT' && (
        <label className="field">
          <span>Where</span>
          <input value={v.location} onChange={(e) => set('location', e.target.value)} />
        </label>
      )}

      <label className="field">
        <span>Details</span>
        <textarea rows={v.kind === 'NOTE' ? 8 : 4} value={v.body} onChange={(e) => set('body', e.target.value)} />
      </label>

      {photo && (
        <div className="note-photo">
          <a href={photo} target="_blank" rel="noreferrer">
            <img src={photo} alt="Attached photo" />
          </a>
          {onRemoveImage && (
            <button type="button" className="photo-remove" aria-label="Remove photo" onClick={onRemoveImage}>
              ✕
            </button>
          )}
        </div>
      )}

      {error && <p className="error">{error.message}</p>}

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
      {footer}
    </form>
  );
}

const UNITS: Record<Freq, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const DAY_LETTERS: Record<Weekday, string> = { MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S' };
const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

/** How an appointment or reminder repeats. Weekly and monthly details come from the date unless changed. */
function RepeatFields({
  date,
  value: r,
  onChange,
}: {
  date: string;
  value: RepeatValues;
  onChange: (value: RepeatValues) => void;
}) {
  const set = <K extends keyof RepeatValues>(key: K, value: RepeatValues[K]) => onChange({ ...r, [key]: value });
  // Until days are picked, weekly means the start's weekday.
  const days = r.days.length ? r.days : [weekdayOf(date)];
  const positions = monthlyPositions(date);
  const dom = Number(date.slice(8));
  // Show what will be saved when the date no longer allows the choice (see ruleFromRepeat).
  const monthly = r.monthly === 'nth' && !positions.nth ? 'last' : r.monthly === 'last' && !positions.last ? 'nth' : r.monthly;
  const interval = Number(r.interval) || 1;

  function toggleDay(day: Weekday) {
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    if (next.length) set('days', next);
  }

  return (
    <div className="repeat">
      <label className="field">
        <span>Repeats</span>
        <select value={r.freq} onChange={(e) => set('freq', e.target.value as Freq | '')}>
          <option value="">Doesn't repeat</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="YEARLY">Yearly</option>
        </select>
      </label>

      {r.freq && (
        <div className="repeat-options">
          <label className="repeat-every">
            Every
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={r.interval}
              onChange={(e) => set('interval', e.target.value)}
            />
            {UNITS[r.freq]}
            {interval === 1 ? '' : 's'}
          </label>

          {r.freq === 'WEEKLY' && (
            <div className="weekday-picks" role="group" aria-label="On these days">
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip ${days.includes(d) ? 'chip-on' : ''}`}
                  aria-pressed={days.includes(d)}
                  aria-label={DAY_NAMES[d]}
                  onClick={() => toggleDay(d)}
                >
                  {DAY_LETTERS[d]}
                </button>
              ))}
            </div>
          )}

          {r.freq === 'MONTHLY' && (
            <select value={monthly} onChange={(e) => set('monthly', e.target.value as RepeatValues['monthly'])}>
              <option value="date">On day {dom}</option>
              {positions.nth && <option value="nth">On {positions.nth}</option>}
              {positions.last && <option value="last">On {positions.last}</option>}
            </select>
          )}

          <div className="repeat-ends">
            <select value={r.ends} onChange={(e) => set('ends', e.target.value as RepeatValues['ends'])}>
              <option value="never">Forever</option>
              <option value="until">Until</option>
              <option value="count">A number of times</option>
            </select>
            {r.ends === 'until' && (
              <input type="date" min={date} value={r.until} onChange={(e) => set('until', e.target.value)} required />
            )}
            {r.ends === 'count' && (
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                placeholder="10"
                value={r.count}
                onChange={(e) => set('count', e.target.value)}
                required
                aria-label="Times"
              />
            )}
          </div>
          {r.freq === 'WEEKLY' && !days.includes(weekdayOf(date)) && (
            <small className="muted">It starts on the first chosen day after the date above.</small>
          )}
        </div>
      )}
    </div>
  );
}
