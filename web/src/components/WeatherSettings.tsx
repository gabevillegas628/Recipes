import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { WeatherPlace } from '../types';

/** Settings → Weather: where Today's high, low and umbrella warning are for. */
export function WeatherSection() {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: ['weather-place'], queryFn: api.weatherPlace });
  const [query, setQuery] = useState('');

  const search = useMutation({ mutationFn: (q: string) => api.findWeatherPlaces(q) });
  const save = useMutation({
    mutationFn: (place: WeatherPlace | null) => api.setWeatherPlace(place),
    onSuccess: (r) => {
      queryClient.setQueryData(['weather-place'], r);
      queryClient.invalidateQueries({ queryKey: ['weather'] });
      search.reset();
      setQuery('');
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (query.trim().length >= 2) search.mutate(query.trim());
  }

  const place = current.data?.place;
  const found = search.data?.places;

  return (
    <section className="settings-section">
      <h2>Weather</h2>
      <p className="muted small">
        Today shows the high and low, and an umbrella warning when rain is likely. Forecasts are from Open-Meteo.
      </p>
      {current.data && <p>{place ? <>For <strong>{place.name}</strong></> : 'No place set yet, so Today doesn’t show the weather.'}</p>}
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{place ? 'Change to' : 'City or zip code'}</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Austin, or 78704" />
        </label>
        <div className="settings-actions">
          <button type="submit" className="btn" disabled={query.trim().length < 2 || search.isPending}>
            {search.isPending ? 'Looking…' : 'Find'}
          </button>
          {place && (
            <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Stop showing weather
            </button>
          )}
        </div>
      </form>
      {search.error && <p className="error">{search.error.message}</p>}
      {save.error && <p className="error">{save.error.message}</p>}
      {found &&
        (found.length ? (
          <ul className="weather-places">
            {found.map((p) => (
              <li key={`${p.lat},${p.lon}`}>
                <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(p)}>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No places found. Try the city name.</p>
        ))}
    </section>
  );
}
