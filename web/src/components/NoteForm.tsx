import { useState, type FormEvent, type ReactNode } from 'react';
import { imageUrl } from '../api';
import type { NoteValues } from '../notes';
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
