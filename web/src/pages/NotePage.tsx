import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { NoteForm } from '../components/NoteForm';
import { inputFromValues, valuesFromNote, type NoteValues } from '../notes';

/** View and edit one note, reminder or appointment. */
export function NotePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const note = useQuery({ queryKey: ['note', id], queryFn: () => api.note(id) });

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ['notes'] });
    navigate('/notes');
  };
  const save = useMutation({
    mutationFn: (values: NoteValues) => api.updateNote(id, inputFromValues(values)),
    onSuccess: done,
  });
  const removePhoto = useMutation({
    mutationFn: () => api.updateNote(id, { image: null }),
    onSuccess: (updated) => queryClient.setQueryData(['note', id], updated),
  });
  const remove = useMutation({ mutationFn: () => api.deleteNote(id), onSuccess: done });

  if (note.isPending) return <div className="page" />;
  if (!note.data) return <div className="page error">{note.error?.message ?? 'Not found'}</div>;
  const n = note.data;

  return (
    <div className="page">
      <h1 className="form-title">Edit</h1>
      <NoteForm
        initial={valuesFromNote(n)}
        image={n.image}
        onRemoveImage={() => confirm('Remove the photo?') && removePhoto.mutate()}
        saving={save.isPending}
        error={save.error ?? remove.error}
        onSubmit={(values) => save.mutate(values)}
        onCancel={() => navigate('/notes')}
        footer={
          <div className="note-footer">
            <p className="muted small">
              Added {n.createdBy ? `by ${n.createdBy.name} ` : ''}
              {new Date(n.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
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
        }
      />
    </div>
  );
}
