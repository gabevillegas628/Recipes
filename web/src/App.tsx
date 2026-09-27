import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Layout } from './components/Layout';
import { BulkImportPage } from './pages/BulkImportPage';
import { CookModePage } from './pages/CookModePage';
import { GroceriesPage } from './pages/GroceriesPage';
import { MealEditPage } from './pages/MealEditPage';
import { MealPage } from './pages/MealPage';
import { MealsPage } from './pages/MealsPage';
import { PrepPage } from './pages/PrepPage';
import { WeekPage } from './pages/WeekPage';
import { TimerProvider, TimerTray } from './timers';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { RecipeDetailPage } from './pages/RecipeDetailPage';
import { RecipeEditPage } from './pages/RecipeEditPage';
import { RecipeListPage } from './pages/RecipeListPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });

  if (me.isPending) return <div className="splash" />;
  if (!me.data) return <LoginPage />;

  return (
    <TimerProvider>
      <TimerTray />
      <Routes>
      {/* Full screen, outside the tab bar layout. */}
      <Route path="r/:id/prep" element={<PrepPage />} />
      <Route path="r/:id/cook" element={<CookModePage />} />
      <Route element={<Layout user={me.data} />}>
        <Route index element={<RecipeListPage />} />
        <Route path="new" element={<RecipeEditPage />} />
        <Route path="meals" element={<MealsPage />} />
        <Route path="meals/new" element={<MealEditPage />} />
        <Route path="m/:id" element={<MealPage />} />
        <Route path="m/:id/edit" element={<MealEditPage />} />
        <Route path="week" element={<WeekPage />} />
        <Route path="groceries" element={<GroceriesPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="import/bulk" element={<BulkImportPage />} />
        <Route path="r/:id" element={<RecipeDetailPage />} />
        <Route path="r/:id/edit" element={<RecipeEditPage />} />
        <Route path="settings" element={<SettingsPage user={me.data} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      </Routes>
    </TimerProvider>
  );
}
