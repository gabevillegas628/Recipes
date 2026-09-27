import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Collage } from '../components/Collage';
import { LibraryTabs } from '../components/LibraryTabs';

export function MealsPage() {
  const meals = useQuery({ queryKey: ['meals'], queryFn: api.meals });

  return (
    <div className="page">
      <header className="list-header">
        <LibraryTabs />
      </header>

      {meals.error && <p className="error">{meals.error.message}</p>}

      {meals.data?.length === 0 && (
        <div className="empty">
          <p>No meals yet.</p>
          <p className="muted">
            A meal is a set of recipes you make together, like a main and two sides, or a whole
            Thanksgiving.
          </p>
        </div>
      )}

      <ul className="recipe-list">
        {meals.data?.map((m) => (
          <li key={m.id}>
            <Link to={`/m/${m.id}`} className="recipe-row">
              <Collage images={m.images} name={m.name} className="thumb" />
              <div className="recipe-row-body">
                <div className="recipe-row-title">{m.name}</div>
                <div className="recipe-row-meta">
                  {[`${m.recipeCount} recipe${m.recipeCount === 1 ? '' : 's'}`, m.servings && `serves ${m.servings}`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="recipe-row-meta">{m.recipeTitles.join(', ')}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="settings-actions meals-new">
        <Link to="/meals/new" className="btn btn-primary">
          New meal
        </Link>
      </div>
    </div>
  );
}
