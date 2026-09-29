import type {
  CaptureResult,
  ConnectorStatus,
  FindTimeInput,
  FindTimeResult,
  Household,
  HouseholdPerson,
  GoogleCalendarChoice,
  GoogleStatus,
  GroceryGroup,
  Meal,
  MealInput,
  MealSummary,
  Note,
  NoteInput,
  PlanItem,
  PrepPlan,
  ImportJob,
  ImportResult,
  Recipe,
  RecipeInput,
  RecipeSummary,
  TagCount,
  TodayCalendar,
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
    // FormData bodies set their own multipart Content-Type.
    headers:
      typeof init.body === 'string'
        ? { 'Content-Type': 'application/json', ...init.headers }
        : init.headers,
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
  getPrep: (id: string) => request<PrepPlan>(`/api/recipes/${id}/prep`),
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
  importPhotos: (photos: Blob[]) => {
    const form = new FormData();
    photos.forEach((p, i) => form.append('photo', p, `photo-${i + 1}.jpg`));
    return request<ImportResult>('/api/import/photo', { method: 'POST', body: form });
  },
  bulkImport: (text: string) =>
    request<{ queued: number; invalid: string[] }>('/api/import/bulk', json('POST', { text })),
  listImportJobs: () => request<ImportJob[]>('/api/import/jobs'),
  retryImportJob: (id: string) =>
    request<{ ok: true }>(`/api/import/jobs/${id}/retry`, { method: 'POST' }),
  clearImportJobs: () => request<{ deleted: number }>('/api/import/jobs', { method: 'DELETE' }),

  uploadImage: (file: Blob) => {
    const form = new FormData();
    form.append('photo', file, 'photo.jpg');
    return request<{ image: string }>('/api/images', { method: 'POST', body: form });
  },

  plan: () => request<PlanItem[]>('/api/plan'),
  addToPlan: (recipeId: string, scale: number) =>
    request<PlanItem>('/api/plan', json('POST', { recipeId, scale })),
  updatePlanItem: (id: string, input: { cooked?: boolean; scale?: number }) =>
    request<{ ok: true }>(`/api/plan/${id}`, json('PATCH', input)),
  removePlanItem: (id: string) => request<void>(`/api/plan/${id}`, { method: 'DELETE' }),
  clearPlan: () => request<{ ok: true }>('/api/plan', { method: 'DELETE' }),

  removeMealFromPlan: (mealId: string) =>
    request<{ ok: true }>(`/api/plan/meal/${mealId}`, { method: 'DELETE' }),

  meals: () => request<MealSummary[]>('/api/meals'),
  meal: (id: string) => request<Meal>(`/api/meals/${id}`),
  createMeal: (input: Omit<MealInput, 'recipes'> & { recipeIds: string[] }) =>
    request<{ id: string }>('/api/meals', json('POST', input)),
  updateMeal: (id: string, input: Partial<MealInput>) =>
    request<{ id: string }>(`/api/meals/${id}`, json('PATCH', input)),
  deleteMeal: (id: string) => request<void>(`/api/meals/${id}`, { method: 'DELETE' }),
  addRecipeToMeal: (mealId: string, recipeId: string) =>
    request<{ ok: true }>(`/api/meals/${mealId}/recipes`, json('POST', { recipeId })),
  addMealToPlan: (mealId: string, factor: number) =>
    request<{ ok: true }>(`/api/meals/${mealId}/plan`, json('POST', { factor })),

  groceries: () => request<GroceryGroup[]>('/api/grocery'),
  addGroceries: (items: { text: string; recipeId?: string | null }[]) =>
    request<{ added: number }>('/api/grocery', json('POST', { items })),
  updateGrocery: (id: string, input: { checked?: boolean; text?: string }) =>
    request<{ ok: true }>(`/api/grocery/${id}`, json('PATCH', input)),
  removeGrocery: (id: string) => request<void>(`/api/grocery/${id}`, { method: 'DELETE' }),
  clearGroceries: (all = false) =>
    request<{ deleted: number }>(`/api/grocery${all ? '?all=true' : ''}`, { method: 'DELETE' }),

  captureConfig: () => request<{ aiEnabled: boolean }>('/api/capture/config'),
  capture: (text: string, photos: Blob[], now: string) => {
    const form = new FormData();
    form.append('text', text);
    form.append('now', now);
    photos.forEach((p, i) => form.append('photo', p, `photo-${i + 1}.jpg`));
    return request<CaptureResult>('/api/capture', { method: 'POST', body: form });
  },

  today: () => request<TodayCalendar>('/api/today'),
  household: () => request<Household>('/api/household'),
  saveHousehold: (input: Omit<Household, 'people'> & { people: HouseholdPerson[] }) =>
    request<Household>('/api/household', json('PUT', input)),
  findTime: (input: FindTimeInput) => request<FindTimeResult>('/api/find-time', json('POST', input)),
  setEventTag: (title: string, people: string[], everyone: boolean) =>
    request<{ ok: true }>('/api/event-tags', json('PUT', { title, people, everyone })),

  notes: () => request<Note[]>('/api/notes'),
  note: (id: string) => request<Note>(`/api/notes/${id}`),
  createNote: (input: NoteInput & { uploadedImage?: string | null }) =>
    request<Note>('/api/notes', json('POST', input)),
  updateNote: (id: string, input: Partial<NoteInput> & { done?: boolean; image?: null }) =>
    request<Note>(`/api/notes/${id}`, json('PATCH', input)),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),

  googleStatus: () => request<GoogleStatus>('/api/google'),
  googleCalendars: () => request<GoogleCalendarChoice[]>('/api/google/calendars'),
  setGoogleCalendar: (calendarId: string) =>
    request<GoogleStatus>('/api/google/calendar', json('PUT', { calendarId })),
  setGoogleReminders: (calendarId: string | null, color: string | null) =>
    request<GoogleStatus>('/api/google/reminders', json('PUT', { calendarId, color })),
  disconnectGoogle: () => request<GoogleStatus>('/api/google', { method: 'DELETE' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/password', json('POST', { currentPassword, newPassword })),

  listUsers: () => request<User[]>('/api/users'),
  createUser: (input: { name: string; email: string; password: string; isAdmin: boolean }) =>
    request<User>('/api/users', json('POST', input)),
  updateUser: (
    id: string,
    input: Partial<{ name: string; email: string; password: string; isAdmin: boolean }>,
  ) => request<User>(`/api/users/${id}`, json('PATCH', input)),
  deleteUser: (id: string) => request<void>(`/api/users/${id}`, { method: 'DELETE' }),

  connectorStatus: () => request<ConnectorStatus>('/api/connector'),
  generateConnector: () =>
    request<ConnectorStatus & { url: string }>('/api/connector', { method: 'POST' }),
  disableConnector: () => request<ConnectorStatus>('/api/connector', { method: 'DELETE' }),
};

export function imageUrl(image: string | null) {
  return image ? `/images/${image}` : null;
}

export function thumbUrl(image: string | null) {
  return image ? `/images/${image.replace(/\.webp$/, '-thumb.webp')}` : null;
}
