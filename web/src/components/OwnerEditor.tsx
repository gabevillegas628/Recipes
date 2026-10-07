import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import type { EventOwner } from '../types';

/**
 * Pick whose a calendar event is, by its title: some people, everyone, or no one.
 * Saved by hand, it's remembered for that title and never re-read by AI.
 */
export function OwnerEditor({
  title,
  people,
  owner,
  onSaved,
  onCancel,
}: {
  title: string;
  people: { id: string; name: string }[];
  owner: Pick<EventOwner, 'people' | 'everyone'>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(owner.people);
  const [everyone, setEveryone] = useState(owner.everyone);
  const save = useMutation({
    mutationFn: () => api.setEventTag(title, everyone ? [] : picked, everyone),
    onSuccess: onSaved,
  });

  return (
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
        <button type="button" className={`chip ${everyone ? 'chip-on' : ''}`} aria-pressed={everyone} onClick={() => setEveryone((v) => !v)}>
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
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
