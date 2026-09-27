import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { User } from '../types';

/** "Change password" for the logged-in user. */
export function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setOpen(false);
    },
  });

  if (!open) {
    return (
      <>
        {change.isSuccess && <p className="muted">Password changed.</p>}
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Change password
        </button>
      </>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    change.mutate();
  }

  return (
    <form className="form inline-form" onSubmit={submit}>
      <label className="field">
        <span>Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>New password</span>
        <small>At least 8 characters.</small>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </label>
      {change.error && <p className="error">{change.error.message}</p>}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={change.isPending}>
          {change.isPending ? 'Saving…' : 'Save password'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Admin-only: list, add, edit and remove people. */
export function PeopleSection({ me }: { me: User }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.listUsers });
  const [adding, setAdding] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  return (
    <section className="settings-section">
      <h2>People</h2>
      <p className="muted">
        Everyone here shares the same recipe box. Admins can manage people.
      </p>

      {users.error && <p className="error">{users.error.message}</p>}
      <ul className="people">
        {users.data?.map((u) => (
          <Person key={u.id} user={u} isMe={u.id === me.id} onChange={refresh} />
        ))}
      </ul>

      {adding ? (
        <AddPerson
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          Add person
        </button>
      )}
    </section>
  );
}

function Person({ user, isMe, onChange }: { user: User; isMe: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState('');

  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.updateUser>[1]) => api.updateUser(user.id, input),
    onSuccess: () => {
      setEditing(false);
      setPassword('');
      onChange();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteUser(user.id),
    onSuccess: onChange,
  });

  function save(e: FormEvent) {
    e.preventDefault();
    update.mutate({
      ...(name !== user.name ? { name } : {}),
      ...(email !== user.email ? { email } : {}),
      ...(password ? { password } : {}),
    });
  }

  const error = update.error ?? remove.error;

  return (
    <li className="person">
      <div className="person-row">
        <div className="person-info">
          <strong>{user.name}</strong>
          {isMe && <span className="badge">you</span>}
          {user.isAdmin && <span className="badge">admin</span>}
          <div className="muted person-email">{user.email}</div>
        </div>
        {!editing && (
          <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>

      {editing && (
        <form className="form inline-form" onSubmit={save}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>New password</span>
            <small>Leave blank to keep their current password.</small>
            <input
              type="text"
              autoComplete="off"
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" disabled={update.isPending}>
              Save
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditing(false);
                setName(user.name);
                setEmail(user.email);
                setPassword('');
              }}
            >
              Cancel
            </button>
          </div>
          {!isMe && (
            <div className="settings-actions person-danger">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => update.mutate({ isAdmin: !user.isAdmin })}
              >
                {user.isAdmin ? 'Remove admin' : 'Make admin'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={() => {
                  if (confirm(`Remove ${user.name}? Their recipes stay in the recipe box.`)) {
                    remove.mutate();
                  }
                }}
              >
                Remove person
              </button>
            </div>
          )}
        </form>
      )}
      {error && <p className="error">{error.message}</p>}
    </li>
  );
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createUser({ name, email, password, isAdmin }),
    onSuccess: onDone,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form className="form inline-form" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label className="field">
        <span>Temporary password</span>
        <small>At least 8 characters. They can change it in Settings after logging in.</small>
        <input
          type="text"
          autoComplete="off"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        Admin (can manage people)
      </label>
      {create.error && <p className="error">{create.error.message}</p>}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add person'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
