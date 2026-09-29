import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Household, HouseholdPerson } from '../types';

type Draft = Omit<Household, 'people'> & { people: (HouseholdPerson & { nicknames: string })[] };

const toDraft = (h: Household): Draft => ({
  ...h,
  people: h.people.map((p) => ({ ...p, nicknames: p.aliases.join(', ') })),
});

/**
 * Settings → Household: who's in the family (and how calendar titles name them),
 * school hours, travel time and usual appointment hours, for finding times.
 */
export function HouseholdSection() {
  const queryClient = useQueryClient();
  const household = useQuery({ queryKey: ['household'], queryFn: api.household });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (household.data && !draft) setDraft(toDraft(household.data));
  }, [household.data, draft]);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.saveHousehold({
        ...d,
        schoolStart: d.schoolStart || null,
        schoolEnd: d.schoolEnd || null,
        people: d.people
          .filter((p) => p.name.trim())
          .map(({ id, name, nicknames, adult }) => ({
            id,
            name: name.trim(),
            aliases: nicknames.split(',').map((a) => a.trim()).filter(Boolean),
            adult,
          })),
      }),
    onSuccess: (h) => {
      queryClient.setQueryData(['household'], h);
      setDraft(toDraft(h));
      setSaved(true);
    },
  });

  if (!draft) return null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft({ ...draft, [key]: value });
  };
  const setPerson = (i: number, change: Partial<Draft['people'][number]>) =>
    set(
      'people',
      draft.people.map((p, j) => (j === i ? { ...p, ...change } : p)),
    );

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(draft!);
  }

  return (
    <section className="settings-section">
      <h2>Household</h2>
      <p className="muted small">
        For finding a time: the app reads names in your calendar event titles to tell whose each one is.
      </p>
      <form className="form" onSubmit={submit}>
        <div className="household-people">
          {draft.people.map((p, i) => (
            <div key={p.id ?? `new-${i}`} className="household-person">
              <input
                aria-label="Name"
                placeholder="Name"
                value={p.name}
                onChange={(e) => setPerson(i, { name: e.target.value })}
              />
              <select aria-label="Adult or child" value={p.adult ? 'adult' : 'child'} onChange={(e) => setPerson(i, { adult: e.target.value === 'adult' })}>
                <option value="adult">Adult</option>
                <option value="child">Child</option>
              </select>
              <button
                type="button"
                className="cook-icon-btn"
                aria-label={`Remove ${p.name || 'person'}`}
                onClick={() => set('people', draft.people.filter((_, j) => j !== i))}
              >
                ✕
              </button>
              <input
                className="household-nicknames"
                aria-label="Nicknames"
                placeholder="Nicknames or initials in titles (optional)"
                value={p.nicknames}
                onChange={(e) => setPerson(i, { nicknames: e.target.value })}
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => set('people', [...draft.people, { name: '', aliases: [], nicknames: '', adult: true }])}
          >
            + Add person
          </button>
        </div>

        <div className="field">
          <span>Kids’ school, weekdays</span>
          <div className="field-row field-row-2">
            <input type="time" aria-label="School starts" value={draft.schoolStart ?? ''} onChange={(e) => set('schoolStart', e.target.value || null)} />
            <input type="time" aria-label="School ends" value={draft.schoolEnd ?? ''} onChange={(e) => set('schoolEnd', e.target.value || null)} />
          </div>
          <small>Times during school are offered last. Clear both for no school.</small>
        </div>

        <div className="field">
          <span>Usual appointment hours, weekdays</span>
          <div className="field-row field-row-2">
            <input type="time" aria-label="From" value={draft.hoursStart} onChange={(e) => set('hoursStart', e.target.value)} required />
            <input type="time" aria-label="Until" value={draft.hoursEnd} onChange={(e) => set('hoursEnd', e.target.value)} required />
          </div>
          <small>A request can change these (“Saturday is fine”, “after 6”).</small>
        </div>

        <label className="field">
          <span>Travel time each way (minutes)</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            value={draft.travelMinutes}
            onChange={(e) => set('travelMinutes', Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </label>

        {save.error && <p className="error">{save.error.message}</p>}
        <div className="settings-actions">
          <button className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="muted small">Saved.</span>}
        </div>
      </form>
    </section>
  );
}
