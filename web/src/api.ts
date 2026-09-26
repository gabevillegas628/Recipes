import type {
  ImportJob,
  ImportResult,
  Recipe,
  RecipeInput,
  RecipeSummary,
  TagCount,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  me: () => request<User>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<User>('/api/auth/login', json('POST', { email, password })),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  listRecipes: (params: { q?: string; tag?: string; favorite?: boolean }) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.tag) search.set('tag', params.tag);
    if (params.favorite) search.set('favorite', 'true');
    const qs = search.toString();
    return request<RecipeSummary[]>(`/api/recipes${qs ? `?${qs}` : ''}`);
  },
  getRecipe: (id: string) => request<Recipe>(`/api/recipes/${id}`),
  createRecipe: (input: RecipeInput) => request<Recipe>('/api/recipes', json('POST', input)),
  updateRecipe: (id: string, input: RecipeInput) =>
    request<Recipe>(`/api/recipes/${id}`, json('PUT', input)),
  setFavorite: (id: string, favorite: boolean) =>
    request<{ favorite: boolean }>(`/api/recipes/${id}/favorite`, json('PATCH', { favorite })),
  deleteRecipe: (id: string) => request<void>(`/api/recipes/${id}`, { method: 'DELETE' }),
  listTags: () => request<TagCount[]>('/api/tags'),

  importConfig: () => request<{ aiEnabled: boolean }>('/api/import/config'),
  importUrl: (url: string) => request<ImportResult>('/api/import/url', json('POST', { url })),
  importText: (text: string, url?: string) =>
    request<ImportResult>('/api/import/text', json('POST', { text, url })),
  bulkImport: (text: string) =>
    request<{ queued: number; invalid: string[] }>('/api/import/bulk', json('POST', { text })),
  listImportJobs: () => request<ImportJob[]>('/api/import/jobs'),
  retryImportJob: (id: string) =>
    request<{ ok: true }>(`/api/import/jobs/${id}/retry`, { method: 'POST' }),
  clearImportJobs: () => request<{ deleted: number }>('/api/import/jobs', { method: 'DELETE' }),
};

export function imageUrl(image: string | null) {
  return image ? `/images/${image}` : null;
}

export function thumbUrl(image: string | null) {
  return image ? `/images/${image.replace(/\.webp$/, '-thumb.webp')}` : null;
}
