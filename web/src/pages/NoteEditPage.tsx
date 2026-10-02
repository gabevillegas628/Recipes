import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { NoteForm } from '../components/NoteForm';
import { inputFromValues, valuesFromNote, type NoteValues } from '../notes';

/** Edit one note, reminder or appointment. Saving or cancelling goes back to viewing it. */
export function NoteEditPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const note = useQuery({ queryKey: ['note', id], queryFn: () => api.note(id) });

  // Back to the view it was opened from, or to it if this page was opened directly.
  const back = () => (location.key === 'default' ? navigate(`/n/${id}`, { replace: true }) : navigate(-1));
  const save = useMutation({
    mutationFn: (values: NoteValues) => api.updateNote(id, inputFromValues(values)),
    onSuccess: (updated) => {
      queryClient.setQueryData(['note', id], updated);
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      back();
    },
  });
  const removePhoto = useMutation({
    mutationFn: () => api.updateNote(id, { image: null }),
    onSuccess: (updated) => queryClient.setQueryData(['note', id], updated),
  });

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
        error={save.error}
        onSubmit={(values) => save.mutate(values)}
        onCancel={back}
      />
    </div>
  );
}
