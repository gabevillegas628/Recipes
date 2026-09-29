import { NavLink, Outlet, useLocation } from 'react-router-dom';

/**
 * Five tabs: Today (home), Kitchen (recipes, meals, this week), Add in the middle,
 * Groceries and Notes. Settings opens from Today.
 */
export function Layout() {
  const { pathname } = useLocation();
  const tab = (active: boolean, extra = '') => `tab ${extra} ${active ? 'active' : ''}`;
  return (
    <div className="app">
      <main className="main">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end className={({ isActive }) => tab(isActive || pathname.startsWith('/settings'))}>
          <SunIcon />
          <span>Today</span>
        </NavLink>
        <NavLink
          to="/recipes"
          // Recipes, meals, this week and each recipe all live under Kitchen.
          className={({ isActive }) => tab(isActive || /^\/(meals|m\/|r\/|week|new)/.test(pathname))}
        >
          <PotIcon />
          <span>Kitchen</span>
        </NavLink>
        <NavLink to="/add" className={({ isActive }) => tab(isActive || pathname.startsWith('/import'), 'tab-add')}>
          <span className="tab-add-button">
            <PlusIcon />
          </span>
          <span>Add</span>
        </NavLink>
        <NavLink to="/groceries" className={({ isActive }) => tab(isActive)}>
          <CartIcon />
          <span>Groceries</span>
        </NavLink>
        <NavLink to="/notes" className={({ isActive }) => tab(isActive || pathname.startsWith('/n/'))}>
          <NoteIcon />
          <span>Notes</span>
        </NavLink>
      </nav>
    </div>
  );
}

const iconProps = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function SunIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** A pot with a lid, for the Kitchen tab. */
function PotIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
      <path d="M2 10h20M9 7c0-1.2 1.3-2 3-2s3 .8 3 2" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg {...iconProps}>
      <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2" />
      <circle cx="10" cy="20" r="1.3" />
      <circle cx="17" cy="20" r="1.3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...iconProps} strokeWidth={2.5}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </svg>
  );
}
