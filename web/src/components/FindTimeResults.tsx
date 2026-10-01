import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { FindTimeDay } from './FindTimeDay';
import type { EventTagInfo, FindTimeOption, FindTimeResult } from '../types';

/**
 * "Find a time" results: the best few windows, with plain reasons and a glance
 * at each one's day (FindTimeDay). Tapping one
 * turns it into an appointment to check and save. Below, whose each calendar
 * event was taken to be, which can be corrected (and the search runs again).
 */
export function FindTimeResults({
  result: initial,
  onPick,
  onCancel,
}: {
  result: FindTimeResult;
  onPick: (option: FindTimeOption, result: FindTimeResult) => void;
  onCancel: () => void;
}) {
  const [result, setResult] = useState(initial);
  const [showCalendar, setShowCalendar] = useState(false);
  const rerun = useMutation({ mutationFn: () => api.findTime(result.input), onSuccess: setResult });

  return (
    <div className="page">
      <h1 className="form-title">Find a time</h1>
      <p className="find-title">{result.input.title}</p>
      <p className="muted small find-summary">{result.summary}</p>

      {result.options.length === 0 ? (
        <div className="banner">
          Nothing fits then. Try a wider range of days, a shorter visit, or different hours, like “any
          time next two weeks” or “Saturday is fine”.
        </div>
      ) : (
        <ul className="find-options">
          {result.options.map((o) => (
            <li key={`${o.draft.date}-${o.draft.time}`}>
              <button type="button" className="find-option" onClick={() => onPick(o, result)}>
                <span className="find-day">{o.day}</span>
                <span className="find-window">{o.window}</span>
                {o.reasons.map((r) => (
                  <span key={r} className={`find-reason ${o.missesSchool && /school/.test(r) ? 'warn' : ''}`}>
                    {r}
                  </span>
                ))}
                <FindTimeDay view={o.dayView} title={result.input.title} who={result.input.people} people={result.people} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.options.length > 0 && <p className="muted small">Tap one to make it an appointment. You can change the time before saving.</p>}

      {result.notes.length > 0 && (
        <ul className="find-notes">
          {result.notes.map((n) => (
            <li key={n} className="muted small">
              {n}
            </li>
          ))}
        </ul>
      )}

      {result.calendar.length > 0 && (
        <section className="find-calendar">
          <button type="button" className="link-btn" onClick={() => setShowCalendar((v) => !v)}>
            {showCalendar ? '▾' : '▸'} Whose events are these? ({result.calendar.length})
          </button>
          {showCalendar && (
            <ul className="tag-list">
              {result.calendar.map((e) => (
                <TagRow key={e.title} event={e} people={result.people} onSaved={() => rerun.mutate()} />
              ))}
            </ul>
          )}
          {rerun.isPending && <p className="muted small">Looking again…</p>}
          {rerun.error && <p className="error">{rerun.error.message}</p>}
        </section>
      )}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Back
        </button>
      </div>
    </div>
  );
}

/** One event title and whose it is; tap Change to correct it. */
function TagRow({
  event,
  people,
  onSaved,
}: {
  event: EventTagInfo;
  people: FindTimeResult['people'];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>(event.people);
  const [everyone, setEveryone] = useState(event.everyone);
  const save = useMutation({
    mutationFn: () => api.setEventTag(event.title, everyone ? [] : picked, everyone),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });

  const label = event.everyone
    ? 'Everyone'
    : event.unsure
      ? 'Not sure (counted as everyone)'
      : event.people.length
        ? event.people.map((id) => people.find((p) => p.id === id)?.name ?? '?').join(', ')
        : 'No one (doesn’t block time)';

  return (
    <li className="tag-row">
      <div className="tag-row-main">
        <span className="tag-title">{event.title}</span>
        <span className={`tag-who ${event.unsure ? 'warn' : ''}`}>{label}</span>
        {!editing && (
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
      </div>
      {editing && (
        <div className="tag-edit">
          <div className="chips">
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip ${!everyone && picked.includes(p.id) ? 'chip-on' : ''}`}
                aria-pressed={!everyone && picked.includes(p.id)}
                onClick={() => {
                  setEveryone(false);
                  setPicked((prev) => (prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id]));
                }}
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              className={`chip ${everyone ? 'chip-on' : ''}`}
              aria-pressed={everyone}
              onClick={() => setEveryone((v) => !v)}
            >
              Everyone
            </button>
          </div>
          <p className="muted small">
            {!everyone && picked.length === 0 ? 'No one picked: it won’t block anyone’s time.' : 'Remembered for this title from now on.'}
          </p>
          {save.error && <p className="error">{save.error.message}</p>}
          <div className="settings-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
