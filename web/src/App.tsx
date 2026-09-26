import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { Layout } from './components/Layout';
import { BulkImportPage } from './pages/BulkImportPage';
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
    <Routes>
      <Route element={<Layout user={me.data} />}>
        <Route index element={<RecipeListPage />} />
        <Route path="new" element={<RecipeEditPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="import/bulk" element={<BulkImportPage />} />
        <Route path="r/:id" element={<RecipeDetailPage />} />
        <Route path="r/:id/edit" element={<RecipeEditPage />} />
        <Route path="settings" element={<SettingsPage user={me.data} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
