import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

/**
 * Five tabs: Today (home), Kitchen, Add in the middle, Money and Notes.
 * Kitchen opens a small menu: Recipes (recipes, meals, this week) or Groceries.
 * Settings opens from Today.
 */
export function Layout() {
  const { pathname } = useLocation();
  const [kitchenOpen, setKitchenOpen] = useState(false);
  // Close the menu once it has taken you somewhere (or you went elsewhere).
  useEffect(() => setKitchenOpen(false), [pathname]);
  const tab = (active: boolean, extra = '') => `tab ${extra} ${active ? 'active' : ''}`;
  // Recipes, meals, this week, each recipe and groceries all live under Kitchen.
  const inKitchen = /^\/(recipes|meals|m\/|r\/|week|new|groceries)/.test(pathname);
  const inRecipes = inKitchen && !pathname.startsWith('/groceries');

  return (
    <div className="app">
      <main className="main">
        <Outlet />
      </main>
      {kitchenOpen && <div className="kitchen-scrim" onClick={() => setKitchenOpen(false)} />}
      <nav className="tabbar">
        <NavLink to="/" end className={({ isActive }) => tab(isActive || pathname.startsWith('/settings'))}>
          <SunIcon />
          <span>Today</span>
        </NavLink>
        <button
          type="button"
          className={tab(inKitchen || kitchenOpen)}
          aria-haspopup="menu"
          aria-expanded={kitchenOpen}
          onClick={() => setKitchenOpen((o) => !o)}
        >
          <PotIcon />
          <span>Kitchen</span>
        </button>
        {kitchenOpen && (
          <div className="kitchen-menu" role="menu">
            <NavLink to="/recipes" role="menuitem" className={inRecipes ? 'on' : ''}>
              <PotIcon />
              Recipes
            </NavLink>
            <NavLink to="/groceries" role="menuitem">
              <CartIcon />
              Groceries
            </NavLink>
          </div>
        )}
        <NavLink to="/add" className={({ isActive }) => tab(isActive || pathname.startsWith('/import'), 'tab-add')}>
          <span className="tab-add-button">
            <PlusIcon />
          </span>
          <span>Add</span>
        </NavLink>
        <NavLink to="/money" className={({ isActive }) => tab(isActive)}>
          <WalletIcon />
          <span>Money</span>
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

function WalletIcon() {
  return (
    <svg {...iconProps}>
      <path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6" />
      <path d="M16 13.5h.01" />
    </svg>
  );
}
