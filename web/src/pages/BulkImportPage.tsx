import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { ImportJob } from '../types';

const STATUS_LABEL: Record<ImportJob['status'], string> = {
  PENDING: 'Waiting',
  RUNNING: 'Importing',
  DONE: 'Imported',
  DUPLICATE: 'Already saved',
  FAILED: 'Failed',
};

export function BulkImportPage() {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');

  const jobs = useQuery({
    queryKey: ['import-jobs'],
    queryFn: api.listImportJobs,
    // Poll while anything is still in progress.
    refetchInterval: (query) =>
      query.state.data?.some((j) => j.status === 'PENDING' || j.status === 'RUNNING')
        ? 2000
        : false,
  });

  // New recipes appear as jobs finish; keep the recipe list fresh.
  const doneCount = jobs.data?.filter((j) => j.status === 'DONE').length ?? 0;
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['recipes'] });
    queryClient.invalidateQueries({ queryKey: ['tags'] });
  }, [doneCount, queryClient]);

  const submit = useMutation({
    mutationFn: () => api.bulkImport(text),
    onSuccess: () => {
      setText('');
      queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
    },
  });
  const retry = useMutation({
    mutationFn: api.retryImportJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['import-jobs'] }),
  });
  const clear = useMutation({
    mutationFn: api.clearImportJobs,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['import-jobs'] }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit.mutate();
  }

  const list = jobs.data ?? [];
  const counts = list.reduce<Record<string, number>>((acc, j) => {
    acc[j.status] = (acc[j.status] ?? 0) + 1;
    return acc;
  }, {});
  const hasFinished = list.some((j) => j.status !== 'PENDING' && j.status !== 'RUNNING');

  return (
    <div className="page">
      <h1 className="form-title">Import many</h1>

      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span>Recipe links</span>
          <small>One per line. They import in the background, so you can leave this page.</small>
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'https://…\nhttps://…'}
            required
          />
        </label>
        {submit.error && <p className="error">{submit.error.message}</p>}
        {submit.data && submit.data.invalid.length > 0 && (
          <p className="muted">
            Skipped {submit.data.invalid.length} line(s) that weren't links.
          </p>
        )}
        <div className="form-actions">
          <button className="btn btn-primary" disabled={submit.isPending}>
            {submit.isPending ? 'Adding…' : 'Import all'}
          </button>
        </div>
      </form>

      {list.length > 0 && (
        <section className="jobs">
          <div className="jobs-header">
            <p className="muted">
              {(['DONE', 'DUPLICATE', 'FAILED', 'RUNNING', 'PENDING'] as const)
                .filter((s) => counts[s])
                .map((s) => `${counts[s]} ${STATUS_LABEL[s].toLowerCase()}`)
                .join(' · ')}
            </p>
            {hasFinished && (
              <button type="button" className="btn btn-small" onClick={() => clear.mutate()}>
                Clear finished
              </button>
            )}
          </div>
          <ul className="job-list">
            {list.map((job) => (
              <li key={job.id} className="job">
                <span className={`status status-${job.status.toLowerCase()}`}>
                  {STATUS_LABEL[job.status]}
                </span>
                <div className="job-body">
                  {job.recipe ? (
                    <Link to={`/r/${job.recipe.id}`} className="job-title">
                      {job.recipe.title}
                    </Link>
                  ) : (
                    <span className="job-url">{shortUrl(job.url)}</span>
                  )}
                  {job.method === 'ai' && job.status === 'DONE' && (
                    <span className="muted job-note">Extracted with AI; worth a check</span>
                  )}
                  {job.error && <span className="error job-note">{job.error}</span>}
                </div>
                {job.status === 'FAILED' && (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => retry.mutate(job.id)}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}
