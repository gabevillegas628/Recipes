import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { FindTimeResults } from '../components/FindTimeResults';
import { blockOn, localDate } from '../notes';

/**
 * "Find another time" for a missed reminder: free times over the next couple of
 * days, as long as its block was. The one picked becomes its new time.
 */
export function ReminderTimePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const found = useQuery({
    queryKey: ['reminder-time', id],
    queryFn: () => api.findTimeForReminder(id!, localDate(new Date())),
    staleTime: Infinity,
    retry: false,
  });
  const save = useMutation({
    mutationFn: ({ day, start, end }: { day: string; start: number; end: number }) => api.updateNote(id!, blockOn(day, start, end)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      navigate('/');
    },
  });

  if (found.error) {
    return (
      <div className="page">
        <h1 className="form-title">Find another time</h1>
        <p className="error">{found.error.message}</p>
        <button type="button" className="btn" onClick={() => navigate(-1)}>
          Back
        </button>
      </div>
    );
  }
  if (!found.data) return <div className="page muted">Looking for a free time…</div>;

  return (
    <>
      <FindTimeResults
        result={found.data}
        hint="Tap one to move the reminder there."
        onCancel={() => navigate(-1)}
        onPick={(option) => {
          const { start, end } = option.dayView.trip;
          save.mutate({ day: option.draft.date, start, end });
        }}
      />
      {save.error && <p className="error page">{save.error.message}</p>}
    </>
  );
}
