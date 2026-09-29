import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { NoteForm } from '../components/NoteForm';
import { inputFromValues, nowInWords, valuesFromDraft, type NoteValues } from '../notes';
import { shrinkPhoto } from '../photos';
import type { NoteDraft } from '../types';
import { extractUrl, PhotoPicker } from './ImportPage';

/**
 * The Add tab: type, dictate, paste or photograph anything, and AI sorts it into
 * an appointment, reminder, note, recipe or grocery list. Notes get a quick check
 * before saving; recipes open in the usual recipe review; grocery lists show the
 * items to add.
 */
export function CapturePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [groceries, setGroceries] = useState<string | null>(null);

  const config = useQuery({ queryKey: ['capture-config'], queryFn: api.captureConfig });

  const sort = useMutation({
    mutationFn: async () =>
      api.capture(text, await Promise.all(photos.map((p) => shrinkPhoto(p))), nowInWords()),
    onSuccess: (result) => {
      if (result.kind === 'recipe') navigate('/import', { state: { result: result.recipe } });
      else if (result.kind === 'groceries') setGroceries(result.items.join('\n'));
      else setDraft(result.note);
    },
  });

  const save = useMutation({
    mutationFn: (values: NoteValues) =>
      api.createNote({ ...inputFromValues(values), uploadedImage: draft?.uploadedImage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
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
    sort.reset();
    save.reset();
    addGroceries.reset();
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

  if (draft) {
    return (
      <div className="page">
        <h1 className="form-title">Check and save</h1>
        <NoteForm
          initial={valuesFromDraft(draft)}
          image={draft.uploadedImage}
          saving={save.isPending}
          error={save.error}
          onSubmit={(values) => save.mutate(values)}
          onCancel={reset}
        />
      </div>
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
            An appointment, a reminder, a note, a grocery list or a recipe. Tap the mic on your
            keyboard to dictate.
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
