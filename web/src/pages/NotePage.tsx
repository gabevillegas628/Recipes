import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, imageUrl } from '../api';
import { LinkedText, mapsUrl } from '../components/LinkedText';
import { comingUpOn, dayLabel, dayOf, isOverdue, reminderDue, repeatLabel, timeLabel } from '../notes';
import type { Note, NoteKind } from '../types';

const KIND_LABELS: Record<NoteKind, string> = { APPOINTMENT: 'Appointment', REMINDER: 'Reminder', NOTE: 'Note' };

/** One note, reminder or appointment, with its links, address and numbers ready to tap. */
export function NotePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const note = useQuery({ queryKey: ['note', id], queryFn: () => api.note(id) });

  const close = () => navigate('/');
  // Same as the Today and Notes lists: a repeating reminder ticks off one occurrence and moves on.
  const toggle = useMutation({
    mutationFn: (n: Note) => api.updateNote(n.id, { done: Boolean(n.recurrence) || !n.doneAt }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['note', id], updated);
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      navigate('/', { replace: true });
    },
  });

  if (note.isPending) return <div className="page" />;
  if (!note.data) return <div className="page error">{note.error?.message ?? 'Not found'}</div>;
  const n = note.data;
  const photo = imageUrl(n.image);

  // For a repeating item, the occurrence that's next rather than the first one.
  const on = !n.startsAt
    ? null
    : n.kind === 'APPOINTMENT'
      ? comingUpOn(n)
      : n.recurrence
        ? reminderDue(n)
        : dayOf(n.startsAt, n.allDay);
  const when = n.startsAt && n.kind !== 'NOTE' ? (on ? timeLabel(n, true, on) : 'Over') : null;
  const repeats = n.kind !== 'NOTE' ? repeatLabel(n) : '';
  const overdue = n.kind === 'REMINDER' && isOverdue(n);
  const done = n.kind === 'REMINDER' && !n.recurrence && Boolean(n.doneAt);

  return (
    <article className="page note-view">
      <p className="note-kind">{KIND_LABELS[n.kind]}</p>
      <h1 className={`note-view-title ${done ? 'done' : ''}`}>{n.title}</h1>

      {(when || repeats || done) && (
        <p className="note-when">
          {when}
          {repeats && <span className="muted">{when ? ' · ' : ''}↻ {repeats}</span>}
          {overdue && <span className="overdue"> · Overdue since {dayLabel(dayOf(n.startsAt!, n.allDay))}</span>}
          {done && <span className="muted">{when ? ' · ' : ''}Done</span>}
        </p>
      )}

      {n.location && (
        <p className="note-location">
          <span>
            <LinkedText text={n.location} />
          </span>
          <a className="btn btn-small" href={mapsUrl(n.location)} target="_blank" rel="noreferrer">
            Directions
          </a>
        </p>
      )}

      {n.body && (
        <p className="note-body">
          <LinkedText text={n.body} />
        </p>
      )}

      {photo && (
        <div className="note-photo">
          <a href={photo} target="_blank" rel="noreferrer">
            <img src={photo} alt="Attached photo" />
          </a>
        </div>
      )}

      {(toggle.error ?? remove.error) && <p className="error">{(toggle.error ?? remove.error)!.message}</p>}

      <div className="actions">
        <Link to={`/n/${n.id}/edit`} className="btn btn-primary">
          Edit
        </Link>
        {n.kind === 'REMINDER' && (
          <button type="button" className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(n)}>
            {done ? 'Not done' : n.recurrence ? 'Done this time' : 'Mark done'}
          </button>
        )}
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
      </div>

      <div className="note-footer">
        <p className="muted small">
          Added {n.createdBy ? `by ${n.createdBy.name} ` : ''}
          {new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          {n.syncError
            ? ` · Couldn't add to Google Calendar: ${n.syncError}`
            : n.googleEventId
              ? ' · On Google Calendar'
              : ''}
        </p>
        <button
          type="button"
          className="btn btn-danger btn-small"
          disabled={remove.isPending}
          onClick={() => confirm(`Delete "${n.title}"?`) && remove.mutate()}
        >
          Delete
        </button>
      </div>
    </article>
  );
}
