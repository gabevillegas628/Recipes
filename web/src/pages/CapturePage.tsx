import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { FindTimeDay } from '../components/FindTimeDay';
import { FindTimeForm } from '../components/FindTimeForm';
import { FindTimeResults } from '../components/FindTimeResults';
import { NoteForm } from '../components/NoteForm';
import { dayLabel, inputFromValues, localDate, nowInWords, valuesFromDraft, type FormKind, type NoteValues } from '../notes';
import { shrinkPhoto } from '../photos';
import type { FindTimeInput, FindTimeResult, NoteDraft, TaskSlot } from '../types';
import { extractUrl, PhotoPicker } from './ImportPage';

/**
 * The Add tab: type, dictate, paste or photograph anything, and AI sorts it into
 * an appointment, reminder, note, recipe or grocery list, finds a time for
 * something, or writes a recipe asked for. Notes get a quick check before saving; recipes open in the usual
 * recipe review; grocery lists show the items to add; a time search shows options,
 * and the one picked becomes an appointment to check.
 */
export function CapturePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [groceries, setGroceries] = useState<string | null>(null);
  const [found, setFound] = useState<FindTimeResult | null>(null);
  // A task's auto-picked time, and other times for it when asked.
  const [slot, setSlot] = useState<TaskSlot | null>(null);
  const [otherTimes, setOtherTimes] = useState<FindTimeResult | null>(null);
  // Finding a time by hand (no AI), and the last search, to come back to from its results.
  const [manual, setManual] = useState(false);
  const [manualInput, setManualInput] = useState<FindTimeInput | null>(null);
  // Typing one in by hand: what's being added, for the heading.
  const [byHand, setByHand] = useState<string | null>(null);

  const config = useQuery({ queryKey: ['capture-config'], queryFn: api.captureConfig });

  // From free time on Today (?add=reminder&date=…&time=…&end=…): straight to that form, with the time filled in.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const kind = params.get('add');
    if (kind !== 'reminder' && kind !== 'appointment') return;
    addByHand(kind === 'reminder' ? 'REMINDER' : 'APPOINTMENT', kind, {
      date: params.get('date'),
      time: params.get('time'),
      endTime: params.get('end'),
    });
    setParams({}, { replace: true });
  }, [params]);

  const sort = useMutation({
    mutationFn: async () =>
      api.capture(text, await Promise.all(photos.map((p) => shrinkPhoto(p))), nowInWords()),
    onSuccess: (result) => {
      if (result.kind === 'recipe') navigate('/import', { state: { result: result.recipe } });
      else if (result.kind === 'groceries') setGroceries(result.items.join('\n'));
      else if (result.kind === 'findTime') setFound(result.find);
      else {
        setDraft(result.note);
        setSlot(result.slot ?? null);
      }
    },
  });

  const pickAnother = useMutation({ mutationFn: api.findTime, onSuccess: setOtherTimes });
  const findByHand = useMutation({ mutationFn: api.findTime, onSuccess: setFound });

  const save = useMutation({
    mutationFn: ({ values, image }: { values: NoteValues; image: string | null }) =>
      api.createNote({ ...inputFromValues(values), uploadedImage: image }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      queryClient.invalidateQueries({ queryKey: ['note-groups'] });
      navigate('/notes');
    },
  });

  const addGroceries = useMutation({
    mutationFn: (items: string[]) => api.addGroceries(items.map((t) => ({ text: t }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groceries'] });
      navigate('/groceries');
    },
  });

  function reset() {
    setDraft(null);
    setGroceries(null);
    setFound(null);
    setSlot(null);
    setOtherTimes(null);
    setManual(false);
    setManualInput(null);
    setByHand(null);
    pickAnother.reset();
    findByHand.reset();
    sort.reset();
    save.reset();
    addGroceries.reset();
  }

  /** A blank form of that kind. Reminders and appointments start on today (or `at`); a to-do has no date. */
  function addByHand(kind: FormKind, label: string, at?: { date: string | null; time: string | null; endTime: string | null }) {
    setByHand(label);
    setDraft({
      kind: kind === 'TODO' ? 'REMINDER' : kind,
      title: '',
      body: null,
      date: kind === 'REMINDER' || kind === 'APPOINTMENT' ? (at?.date ?? localDate(new Date())) : null,
      time: at?.time ?? null,
      endDate: null,
      endTime: at?.endTime ?? null,
      location: null,
      recurrence: null,
      group: null,
      uploadedImage: null,
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // A bare link is almost always a recipe: go straight to the import, which handles duplicates.
    const link = extractUrl(text);
    if (link && photos.length === 0 && text.trim() === link) {
      navigate(`/import?url=${encodeURIComponent(link)}`);
      return;
    }
    sort.mutate();
  }

  if (draft && otherTimes) {
    return (
      <FindTimeResults
        result={otherTimes}
        hint="Tap one to use it instead. You can change the time before saving."
        onCancel={() => setOtherTimes(null)}
        onPick={(option) => {
          // The whole trip is the task's time: travel there, doing it, travel back.
          const { start, end } = option.dayView.trip;
          setDraft({ ...draft, date: option.draft.date, time: hhmm(start), endTime: hhmm(Math.min(end, 24 * 60 - 1)), endDate: null });
          if (slot) setSlot({ ...slot, day: { view: option.dayView, people: otherTimes.people } });
          setOtherTimes(null);
        }}
      />
    );
  }

  if (draft) {
    return (
      <div className="page">
        <h1 className="form-title">{byHand ? `New ${byHand}` : 'Check and save'}</h1>
        {slot && draft.kind === 'REMINDER' && (
          <div className="slot-banner">
            {draft.time ? (
              <p className="slot-picked">
                Booked a free time: {dayLabel(draft.date!)}, {clock(draft.time)}
                {draft.endTime ? `–${clock(draft.endTime)}` : ''}
              </p>
            ) : (
              <p className="slot-picked">No free time found.</p>
            )}
            {slot.why && <p className="slot-why">{slot.why}</p>}
            {slot.day && draft.time && (
              <FindTimeDay view={slot.day.view} title={draft.title} who={slot.input?.people ?? []} people={slot.day.people} />
            )}
            <p className="muted small">{slot.summary}</p>
            {slot.notes.map((n) => (
              <p key={n} className="muted small">
                {n}
              </p>
            ))}
            {slot.input && (
              <button type="button" className="btn btn-small" disabled={pickAnother.isPending} onClick={() => pickAnother.mutate(slot.input!)}>
                {pickAnother.isPending ? 'Looking…' : 'Pick another time'}
              </button>
            )}
            {pickAnother.error && <p className="error">{pickAnother.error.message}</p>}
          </div>
        )}
        <NoteForm
          // A new time picked: start the form over from it.
          key={`${draft.date}-${draft.time}-${draft.endTime}`}
          initial={valuesFromDraft(draft)}
          image={draft.uploadedImage}
          saving={save.isPending}
          error={save.error}
          onSubmit={(values, image) => save.mutate({ values, image })}
          // From a time search, go back to the options.
          onCancel={found ? () => setDraft(null) : reset}
        />
      </div>
    );
  }

  if (found) {
    return (
      <FindTimeResults
        result={found}
        // Searched by hand: back to the form, as it was.
        onCancel={manual ? () => setFound(null) : reset}
        onPick={(option, latest) => {
          setFound(latest);
          setDraft({
            kind: 'APPOINTMENT',
            title: latest.input.title,
            body: option.draft.body,
            date: option.draft.date,
            time: option.draft.time,
            endDate: null,
            endTime: option.draft.endTime,
            location: latest.input.location,
            recurrence: null,
            group: null,
            uploadedImage: null,
          });
        }}
      />
    );
  }

  if (manual) {
    return (
      <FindTimeForm
        initial={manualInput}
        searching={findByHand.isPending}
        error={findByHand.error}
        onSubmit={(input) => {
          setManualInput(input);
          findByHand.mutate(input);
        }}
        onCancel={reset}
      />
    );
  }

  if (groceries !== null) {
    const items = groceries.split('\n').map((s) => s.trim()).filter(Boolean);
    return (
      <div className="page">
        <h1 className="form-title">Add to groceries</h1>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (items.length) addGroceries.mutate(items);
          }}
        >
          <label className="field">
            <span>Items</span>
            <small>One per line.</small>
            <textarea rows={Math.min(14, items.length + 2)} value={groceries} onChange={(e) => setGroceries(e.target.value)} />
          </label>
          {addGroceries.error && <p className="error">{addGroceries.error.message}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={reset}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={addGroceries.isPending || items.length === 0}>
              {addGroceries.isPending ? 'Adding…' : `Add ${items.length} item${items.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
        <button
          type="button"
          className="link-btn capture-alt"
          onClick={() =>
            setDraft({
              kind: 'NOTE',
              title: 'List',
              body: groceries,
              date: null,
              time: null,
              endDate: null,
              endTime: null,
              location: null,
              recurrence: null,
              group: null,
              uploadedImage: null,
            })
          }
        >
          Save as a note instead
        </button>
      </div>
    );
  }

  const aiEnabled = config.data?.aiEnabled !== false;
  const empty = !text.trim() && photos.length === 0;

  return (
    <div className="page">
      <h1 className="form-title">Add anything</h1>
      {!aiEnabled && (
        <div className="banner">Sorting needs AI, which isn't set up on the server (ANTHROPIC_API_KEY).</div>
      )}
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Type, dictate or paste</span>
          <small>
            An appointment, a reminder, a note, a grocery list or a recipe. Or ask to find a time
            (“schedule Evan an eye appointment the week of 11/2”) or for a recipe (“a weeknight
            chili”). Tap the mic on your keyboard to dictate.
          </small>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Dentist for Maya next Tuesday at 3:30"
          />
        </label>

        <PhotoPicker
          photos={photos}
          onChange={setPhotos}
          aiEnabled={aiEnabled}
          hint="A flyer, a letter from school, an appointment card or a recipe."
        />

        {sort.error && <p className="error">{sort.error.message}</p>}

        <div className="form-actions">
          <button className="btn btn-primary" disabled={sort.isPending || empty}>
            {sort.isPending ? 'Sorting…' : 'Sort it'}
          </button>
        </div>
      </form>

      <div className="import-more">
        <p className="muted">Or type one in yourself:</p>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={() => addByHand('APPOINTMENT', 'appointment')}>
            Appointment
          </button>
          <button type="button" className="btn" onClick={() => addByHand('REMINDER', 'reminder')}>
            Reminder
          </button>
          <button type="button" className="btn" onClick={() => addByHand('TODO', 'to-do')}>
            To-do
          </button>
          <button type="button" className="btn" onClick={() => addByHand('NOTE', 'note')}>
            Note
          </button>
        </div>
      </div>

      <div className="import-more">
        <p className="muted">Looking for a time for something?</p>
        <div className="settings-actions">
          <button type="button" className="btn" onClick={() => setManual(true)}>
            Find a time
          </button>
        </div>
      </div>

      <div className="import-more">
        <p className="muted">Adding a recipe?</p>
        <div className="settings-actions">
          <Link to="/import" className="btn">
            From a link
          </Link>
          <Link to="/new" className="btn">
            Type it in
          </Link>
          <Link to="/import/bulk" className="btn">
            Many links at once
          </Link>
        </div>
      </div>
    </div>
  );
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** "14:30" as "2:30 PM". */
function clock(time: string) {
  const [h, m] = time.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
