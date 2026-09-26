import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { signOut } from '../session';
import type { ConnectorStatus, User } from '../types';

export function SettingsPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function logout() {
    if (!confirm(`Log out ${user.name}?`)) return;
    await api.logout();
    signOut(queryClient);
    navigate('/', { replace: true });
  }

  return (
    <div className="page settings">
      <h1 className="form-title">Settings</h1>

      <ConnectorSection />

      <section className="settings-section">
        <h2>Account</h2>
        <p>
          {user.name} <span className="muted">· {user.email}</span>
        </p>
        <button type="button" className="btn" onClick={logout}>
          Log out
        </button>
      </section>
    </div>
  );
}

function ConnectorSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['connector'], queryFn: api.connectorStatus });
  // The URL is only available right after generating it.
  const [newUrl, setNewUrl] = useState<string | null>(null);

  const onStatus = (s: ConnectorStatus) => queryClient.setQueryData(['connector'], s);

  const generate = useMutation({
    mutationFn: api.generateConnector,
    onSuccess: ({ url, ...s }) => {
      setNewUrl(url);
      onStatus(s);
    },
  });
  const disable = useMutation({
    mutationFn: api.disableConnector,
    onSuccess: (s) => {
      setNewUrl(null);
      onStatus(s);
    },
  });

  const enabled = status.data?.enabled;

  function regenerate() {
    const ok =
      !enabled ||
      confirm(
        'Generate a new link? The current one stops working, so you’ll need to update the connector in Claude.',
      );
    if (ok) generate.mutate();
  }

  function turnOff() {
    if (confirm('Turn off the Claude connector? Claude will no longer be able to reach your recipes.')) {
      disable.mutate();
    }
  }

  return (
    <section className="settings-section">
      <h2>Claude connector</h2>
      <p className="muted">
        Lets Claude save recipes from your chats straight into this recipe box, and look up or
        update the ones you’ve saved.
      </p>

      {status.data && (
        <p className="connector-status">
          {status.data.enabled ? (
            <>
              <span className="dot dot-on" /> On · link created {formatDate(status.data.createdAt)}
              {' · '}
              {status.data.lastUsedAt
                ? `last used ${formatDate(status.data.lastUsedAt)}`
                : 'not used yet'}
            </>
          ) : (
            <>
              <span className="dot" /> Off
            </>
          )}
        </p>
      )}

      {newUrl && <NewLink url={newUrl} />}

      {(generate.error || disable.error) && (
        <p className="error">{(generate.error ?? disable.error)!.message}</p>
      )}

      <div className="settings-actions">
        {!newUrl && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={regenerate}
            disabled={generate.isPending || status.isPending}
          >
            {enabled ? 'Generate a new link' : 'Set up connector'}
          </button>
        )}
        {enabled && (
          <button type="button" className="btn btn-danger" onClick={turnOff}>
            Turn off
          </button>
        )}
      </div>
    </section>
  );
}

function NewLink({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard API needs HTTPS; fall back to selecting the text.
      input.current?.select();
    }
  }

  return (
    <div className="new-link">
      <p>
        <strong>Your connector link</strong>, shown only once. Treat it like a password: anyone
        with it can read and add recipes.
      </p>
      <div className="copy-row">
        <input ref={input} readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <ol className="steps">
        <li>
          In Claude, open <strong>Settings → Connectors</strong> and choose{' '}
          <strong>Add custom connector</strong>.
        </li>
        <li>Name it “Recipe box” and paste the link as the URL.</li>
        <li>
          In a chat, say something like <em>“save this recipe to my recipe box.”</em>
        </li>
      </ol>
      <p className="muted">
        Connectors sync across the Claude apps, so you only add it once. If the link ever leaks,
        generate a new one here.
      </p>
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
