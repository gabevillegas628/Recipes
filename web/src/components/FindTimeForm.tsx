import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addDays, WEEKDAYS } from '../../../server/src/recurrence';
import { api } from '../api';
import { localDate } from '../notes';
import type { FindTimeInput, Household } from '../types';

const LENGTHS = [15, 30, 45, 60, 90, 120];
const TRAVEL = [0, 10, 15, 20, 30, 45];
/** How far ahead to look, from today: [label, first day offset, last day offset]. */
const RANGES: [string, number, number][] = [
  ['This week', 0, 6],
  ['Next 2 weeks', 0, 13],
  ['Next month', 0, 30],
];
const PARTS: { label: string; hoursStart: string | null; hoursEnd: string | null }[] = [
  { label: 'Any time', hoursStart: null, hoursEnd: null },
  { label: 'Morning', hoursStart: null, hoursEnd: '12:00' },
  { label: 'Afternoon', hoursStart: '12:00', hoursEnd: '17:00' },
  { label: 'Evening', hoursStart: '17:00', hoursEnd: '21:00' },
];

/**
 * "Find a time" without the AI: what, who, how long, travel and when, picked
 * from chips (with a custom amount when none fit). The search is the same one
 * the AI runs from a typed request.
 */
export function FindTimeForm({
  initial,
  searching,
  error,
  onSubmit,
  onCancel,
}: {
  /** The last search, when coming back from its results. */
  initial: FindTimeInput | null;
  searching: boolean;
  error: Error | null;
  onSubmit: (input: FindTimeInput) => void;
  onCancel: () => void;
}) {
  const household = useQuery({ queryKey: ['household'], queryFn: api.household });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const today = localDate(new Date());

  const [title, setTitle] = useState(initial?.title ?? '');
  const [people, setPeople] = useState<string[] | null>(initial?.people ?? null);
  const [length, setLength] = useState(initial?.durationMinutes ?? 60);
  // null: the household's usual travel time.
  const [travel, setTravel] = useState<number | null>(initial?.travelMinutes ?? null);
  const [from, setFrom] = useState(initial?.from ?? today);
  const [to, setTo] = useState(initial?.to ?? addDays(today, 13));
  const [part, setPart] = useState(() => PARTS.findIndex((p) => p.hoursStart === (initial?.hoursStart ?? null) && p.hoursEnd === (initial?.hoursEnd ?? null)));
  const [weekends, setWeekends] = useState(Boolean(initial?.days && initial.days.length > 5));
  const [location, setLocation] = useState(initial?.location ?? '');
  const [details, setDetails] = useState(initial?.details ?? '');

  if (household.isPending) return <div className="page" />;
  if (!household.data) return <div className="page error">{household.error?.message ?? 'Couldn’t load your household'}</div>;
  const h: Household = household.data;
  if (!h.people.length) {
    return (
      <div className="page">
        <h1 className="form-title">Find a time</h1>
        <p>Add your household in Settings first, so the app knows whose events are whose.</p>
        <button type="button" className="btn" onClick={onCancel}>
          Back
        </button>
      </div>
    );
  }

  // Until someone's picked: whoever's signed in, if they're in the household.
  const mine = me.data ? h.people.find((p) => [p.name, ...p.aliases].some((n) => n.toLowerCase() === me.data!.name.toLowerCase())) : undefined;
  const who = people ?? (mine ? [mine.id] : []);
  const usualTravel = travel ?? h.travelMinutes;
  const range = RANGES.findIndex(([, a, b]) => from === addDays(today, a) && to === addDays(today, b));

  function toggle(id: string) {
    setPeople(who.includes(id) ? who.filter((p) => p !== id) : [...who, id]);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // Hours from the last search that aren't one of the choices stay as they were.
    const p = part === -1 ? { hoursStart: initial?.hoursStart ?? null, hoursEnd: initial?.hoursEnd ?? null } : PARTS[part];
    onSubmit({
      title: title.trim(),
      location: location.trim() || null,
      details: details.trim() || null,
      people: who,
      from: from <= to ? from : to,
      to: from <= to ? to : from,
      durationMinutes: length,
      hoursStart: p.hoursStart,
      hoursEnd: p.hoursEnd,
      days: weekends ? [...WEEKDAYS] : null,
      travelMinutes: travel,
    });
  }

  return (
    <div className="page">
      <h1 className="form-title">Find a time</h1>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>What</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Coffee with Sam" required />
        </label>

        <div className="field">
          <span>Who has to be there</span>
          <div className="chips wrap-chips" role="group" aria-label="Who has to be there">
            {h.people.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip ${who.includes(p.id) ? 'chip-on' : ''}`}
                aria-pressed={who.includes(p.id)}
                onClick={() => toggle(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>How long</span>
          <Amounts choices={LENGTHS} value={length} onChange={setLength} label={lengthLabel} max={12 * 60} min={5} />
        </div>

        <div className="field">
          <span>Travel each way</span>
          <Amounts
            choices={TRAVEL}
            value={usualTravel}
            onChange={setTravel}
            label={(m) => (m ? `${m} min` : 'None')}
            max={240}
            min={0}
          />
        </div>

        <div className="field">
          <span>Within</span>
          <div className="chips wrap-chips" role="group" aria-label="Within">
            {RANGES.map(([label, a, b], i) => (
              <button
                key={label}
                type="button"
                className={`chip ${range === i ? 'chip-on' : ''}`}
                aria-pressed={range === i}
                onClick={() => {
                  setFrom(addDays(today, a));
                  setTo(addDays(today, b));
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="field-row field-row-2">
            <input type="date" aria-label="From" value={from} min={today} onChange={(e) => setFrom(e.target.value)} required />
            <input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </div>
        </div>

        <div className="field">
          <span>Time of day</span>
          <div className="chips wrap-chips" role="group" aria-label="Time of day">
            {PARTS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                className={`chip ${part === i ? 'chip-on' : ''}`}
                aria-pressed={part === i}
                onClick={() => setPart(i)}
              >
                {p.label}
              </button>
            ))}
            <button type="button" className={`chip ${weekends ? 'chip-on' : ''}`} aria-pressed={weekends} onClick={() => setWeekends(!weekends)}>
              Weekends too
            </button>
          </div>
        </div>

        <label className="field">
          <span>Where</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional" />
        </label>

        <label className="field">
          <span>Details</span>
          <textarea rows={2} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Optional" />
        </label>

        {error && <p className="error">{error.message}</p>}

        <div className="form-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={searching || !who.length || !title.trim()}>
            {searching ? 'Looking…' : 'Find times'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A row of amount chips in minutes, with "Other" for typing one in. */
function Amounts({
  choices,
  value,
  onChange,
  label,
  min,
  max,
}: {
  choices: number[];
  value: number;
  onChange: (minutes: number) => void;
  label: (minutes: number) => string;
  min: number;
  max: number;
}) {
  const [custom, setCustom] = useState(!choices.includes(value));
  // What's typed, which may not be a usable amount yet ("1" on the way to "120").
  const [text, setText] = useState(String(value));
  return (
    <div className="chips wrap-chips">
      {choices.map((m) => (
        <button
          key={m}
          type="button"
          className={`chip ${!custom && value === m ? 'chip-on' : ''}`}
          aria-pressed={!custom && value === m}
          onClick={() => {
            setCustom(false);
            onChange(m);
          }}
        >
          {label(m)}
        </button>
      ))}
      {custom ? (
        <label className="chip chip-on chip-input">
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={text}
            autoFocus
            aria-label="Minutes"
            onChange={(e) => {
              setText(e.target.value);
              const n = Math.round(Number(e.target.value));
              if (e.target.value && n >= min && n <= max) onChange(n);
            }}
          />
          min
        </label>
      ) : (
        <button
          type="button"
          className="chip"
          onClick={() => {
            setText(String(value));
            setCustom(true);
          }}
        >
          Other…
        </button>
      )}
    </div>
  );
}

/** "15 min", "1 hr", "1.5 hr". */
function lengthLabel(minutes: number) {
  return minutes < 60 ? `${minutes} min` : `${Math.round((minutes / 60) * 100) / 100} hr`;
}
