import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { signOut } from '../session';
import type { User } from '../types';

export function Layout({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logout() {
    if (!confirm(`Log out ${user.name}?`)) return;
    await api.logout();
    signOut(queryClient);
    navigate('/', { replace: true });
  }

  return (
    <div className="app">
      <main className="main">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end className="tab">
          <BookIcon />
          <span>Recipes</span>
        </NavLink>
        <NavLink to="/new" className="tab">
          <PlusIcon />
          <span>Add</span>
        </NavLink>
        <button type="button" className="tab" onClick={logout}>
          <UserIcon />
          <span>{user.name}</span>
        </button>
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

function BookIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
      <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
