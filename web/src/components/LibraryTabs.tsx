import { NavLink } from 'react-router-dom';

/** The Recipes / Meals / This week switch at the top of the Kitchen tab. */
export function LibraryTabs() {
  const on = ({ isActive }: { isActive: boolean }) => (isActive ? 'on' : '');
  return (
    <div className="segmented library-tabs">
      <NavLink to="/recipes" className={on}>
        Recipes
      </NavLink>
      <NavLink to="/meals" className={on}>
        Meals
      </NavLink>
      <NavLink to="/week" className={on}>
        This week
      </NavLink>
    </div>
  );
}
