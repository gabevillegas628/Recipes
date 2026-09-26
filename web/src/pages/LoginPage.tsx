import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function LoginPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (user) => queryClient.setQueryData(['me'], user),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    login.mutate();
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Recipes</h1>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {login.error && <p className="error">{login.error.message}</p>}
        <button className="btn btn-primary" disabled={login.isPending}>
          {login.isPending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
