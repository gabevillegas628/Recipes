import { NavLink } from 'react-router-dom';

/** The Recipes / Meals switch at the top of the Recipes tab. */
export function LibraryTabs() {
  return (
    <div className="segmented library-tabs">
      <NavLink to="/" end className={({ isActive }) => (isActive ? 'on' : '')}>
        Recipes
      </NavLink>
      <NavLink to="/meals" className={({ isActive }) => (isActive ? 'on' : '')}>
        Meals
      </NavLink>
    </div>
  );
}
