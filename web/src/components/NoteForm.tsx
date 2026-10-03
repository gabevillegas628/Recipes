import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { WEEKDAYS, weekdayOf, type Freq, type Weekday } from '../../../server/src/recurrence';
import { api, imageUrl } from '../api';
import { formKindOf, monthlyPositions, NO_REPEAT, type FormKind, type NoteValues, type RepeatValues } from '../notes';
import { shrinkPhoto } from '../photos';
import { PhotoInput } from './PhotoInput';

const KINDS: { kind: FormKind; label: string }[] = [
  { kind: 'APPOINTMENT', label: 'Appointment' },
  { kind: 'REMINDER', label: 'Reminder' },
  { kind: 'TODO', label: 'To-do' },
  { kind: 'NOTE', label: 'Note' },
];

/**
 * Edits a note, to-do, reminder or appointment. The fields shown follow the kind.
 * A to-do is a reminder with no date. The photo is only changed on saving:
 * `onSubmit` gets the one to keep (null for none).
 */
export function NoteForm({
  initial,
  image = null,
  saving,
  error,
  submitLabel = 'Save',
  onSubmit,
  onCancel,
}: {
  initial: NoteValues;
  image?: string | null;
  saving: boolean;
  error?: Error | null;
  submitLabel?: string;
  onSubmit: (values: NoteValues, image: string | null) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState(initial);
  const [formKind, setFormKind] = useState<FormKind>(() => formKindOf(initial));
  const [kept, setKept] = useState(image);
  // Groups already in use, to pick from; typing a new name starts one.
  const groups = useQuery({ queryKey: ['note-groups'], queryFn: api.noteGroups, enabled: formKind === 'NOTE' });
  const upload = useMutation({
    mutationFn: async (file: File) => api.uploadImage(await shrinkPhoto(file)),
    onSuccess: ({ image }) => setKept(image),
  });
  const set = <K extends keyof NoteValues>(key: K, value: NoteValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  // A reminder's end follows its start, so moving the time keeps how long it is.
  const reminderLength = v.kind === 'REMINDER' ? lengthOf(v.time, v.endTime) : 0;
  const setTime = (time: string) =>
    setV((prev) => ({ ...prev, time, endTime: prev.kind === 'REMINDER' ? endAfter(time, reminderLength) : prev.endTime }));
  const photo = imageUrl(kept);

  function pickKind(kind: FormKind) {
    setFormKind(kind);
    setV((prev) => ({ ...prev, kind: kind === 'TODO' ? 'REMINDER' : kind }));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // A to-do keeps no date, even one typed before switching to it.
    onSubmit(formKind === 'TODO' ? { ...v, date: '', time: '', endDate: '', endTime: '', repeat: NO_REPEAT } : v, kept);
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="segmented">
        {KINDS.map((k) => (
          <button key={k.kind} type="button" className={formKind === k.kind ? 'on' : ''} onClick={() => pickKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Title</span>
        <input value={v.title} onChange={(e) => set('title', e.target.value)} required />
      </label>

      {formKind === 'NOTE' && (
        <label className="field">
          <span>Group</span>
          <input
            value={v.group}
            onChange={(e) => set('group', e.target.value)}
            list="note-groups"
            placeholder="Medical, Work, Ideas…"
            autoCapitalize="words"
            maxLength={60}
          />
          <datalist id="note-groups">
            {(groups.data ?? []).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      )}

      {formKind !== 'NOTE' && formKind !== 'TODO' && (
        <>
          <div className="field-row field-row-2">
            <label className="field">
              <span>{v.kind === 'REMINDER' ? 'Due' : 'Date'}</span>
              <input
                type="date"
                value={v.date}
                onChange={(e) => set('date', e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Time</span>
              <input type="time" value={v.time} onChange={(e) => setTime(e.target.value)} disabled={!v.date} />
            </label>
          </div>
          {v.kind === 'REMINDER' && v.time && (
            <div className="field">
              <span>How long</span>
              <div className="chips wrap-chips" role="group" aria-label="How long">
                {/* A length set some other way (Find a time, say) shows as its own choice. */}
                {(LENGTHS.includes(reminderLength) ? LENGTHS : [...LENGTHS, reminderLength].sort((a, b) => a - b)).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`chip ${m === reminderLength ? 'chip-on' : ''}`}
                    aria-pressed={m === reminderLength}
                    onClick={() => set('endTime', endAfter(v.time, m))}
                  >
                    {m ? lengthLabel(m) : 'Just a reminder'}
                  </button>
                ))}
              </div>
            </div>
          )}
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
            {v.kind === 'APPOINTMENT'
              ? 'Leave the time empty for all day.'
              : v.time
                ? reminderLength
                  ? 'The time is blocked on your calendar, and Find a time works around it.'
                  : 'Just a nudge at that time: it doesn’t block your calendar.'
                : 'Leave the time empty for any time that day. No date at all? Make it a to-do.'}
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
          <button type="button" className="photo-remove" aria-label="Remove photo" onClick={() => setKept(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="photo-picker">
        {upload.isPending ? (
          <span className="muted">Uploading photo…</span>
        ) : (
          <>
            <PhotoInput camera onPick={([file]) => upload.mutate(file)}>
              📷 {photo ? 'Retake' : 'Take photo'}
            </PhotoInput>
            <PhotoInput multiple={false} onPick={([file]) => upload.mutate(file)}>
              {photo ? 'Change photo' : 'Add photo'}
            </PhotoInput>
          </>
        )}
        {upload.error && <span className="error">{upload.error.message}</span>}
      </div>

      {error && <p className="error">{error.message}</p>}

      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary" disabled={saving || upload.isPending}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Reminder lengths to pick from, in minutes; 0 is just a reminder, with no end. */
const LENGTHS = [0, 15, 30, 45, 60, 90];

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minutes from a start to an end time the same day; 0 without both. */
function lengthOf(time: string, endTime: string) {
  return time && endTime && endTime > time ? minutesOf(endTime) - minutesOf(time) : 0;
}

/** The end time that many minutes after a start, kept on the same day; '' for no end. */
function endAfter(time: string, minutes: number) {
  if (!time || !minutes) return '';
  const end = Math.min(minutesOf(time) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

/** "15 min", "1 hr", "1.5 hr". */
function lengthLabel(minutes: number) {
  return minutes < 60 ? `${minutes} min` : `${Math.round((minutes / 60) * 100) / 100} hr`;
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
