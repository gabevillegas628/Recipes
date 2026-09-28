import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { GoogleCalendarSection } from '../components/GoogleCalendarSettings';
import { ChangePassword, PeopleSection } from '../components/UserSettings';
import { signOut } from '../session';
import { SHORTCUT_NAME, useTimers } from '../timers';
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

      <GoogleCalendarSection />

      <PhoneSection />

      {user.isAdmin && <PeopleSection me={user} />}

      <section className="settings-section">
        <h2>Account</h2>
        <p>
          {user.name} <span className="muted">· {user.email}</span>
        </p>
        <div className="settings-actions">
          <ChangePassword />
          <button type="button" className="btn" onClick={logout}>
            Log out
          </button>
        </div>
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

type Platform = 'ios' | 'android' | 'other';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac with touch.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function PhoneSection() {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);
  const importBase = `${window.location.origin}/import?url=`;
  const bookmarklet = `javascript:location.href='${importBase}'+encodeURIComponent(location.href)`;
  const installed = window.matchMedia('(display-mode: standalone)').matches;

  return (
    <section className="settings-section">
      <h2>Phone setup</h2>
      <p className="muted">
        Install Recipe Box on your home screen, and add it to the Share button so links from
        Instagram, Messenger or Safari go straight to Import.
      </p>

      <div className="segmented">
        {(['ios', 'android', 'other'] as const).map((p) => (
          <button key={p} type="button" className={platform === p ? 'on' : ''} onClick={() => setPlatform(p)}>
            {p === 'ios' ? 'iPhone' : p === 'android' ? 'Android' : 'Computer'}
          </button>
        ))}
      </div>

      {platform === 'ios' && (
        <>
          <h3>Install</h3>
          {installed ? (
            <p className="muted">You're using the installed app. 👍</p>
          ) : (
            <ol className="steps">
              <li>Open this site in <strong>Safari</strong>.</li>
              <li>Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</li>
            </ol>
          )}
          <h3>Share button (Shortcut)</h3>
          <ol className="steps">
            <li>
              Open the <strong>Shortcuts</strong> app, tap <strong>+</strong>, and name the shortcut
              “Recipe Box”.
            </li>
            <li>
              Tap the <strong>ⓘ</strong> (details) button and turn on{' '}
              <strong>Show in Share Sheet</strong>. Set it to receive <strong>URLs</strong> and{' '}
              <strong>Text</strong>.
            </li>
            <li>
              Add the action <strong>URL Encode</strong> (it encodes the Shortcut Input).
            </li>
            <li>
              Add a <strong>Text</strong> action. Paste the address below, then insert the{' '}
              <strong>URL Encoded Text</strong> variable right after it:
              <CopyField value={importBase} />
            </li>
            <li>
              Add the action <strong>Open URLs</strong>.
            </li>
            <li>
              Now in Instagram, Messenger or Safari: <strong>Share → Recipe Box</strong>. It opens the
              import screen in Safari (log in there once).
            </li>
          </ol>
          <TimerSetup />
        </>
      )}

      {platform === 'android' && (
        <>
          <h3>Install</h3>
          {installed ? (
            <p className="muted">You're using the installed app. 👍</p>
          ) : (
            <ol className="steps">
              <li>Open this site in <strong>Chrome</strong>.</li>
              <li>
                Tap <strong>⋮</strong>, then <strong>Add to Home screen</strong> (or{' '}
                <strong>Install app</strong>).
              </li>
            </ol>
          )}
          <h3>Share button</h3>
          <p>
            Once installed, <strong>Recipe Box</strong> shows up in the Share menu automatically.
            Share a link to it and the import starts right away.
          </p>
        </>
      )}

      {platform === 'other' && (
        <>
          <h3>Bookmark button</h3>
          <p>
            Add a bookmark named “+ Recipe Box” and paste this as its address (URL). Click it on
            any recipe page to import that page.
          </p>
          <CopyField value={bookmarklet} />
        </>
      )}
    </section>
  );
}

function CopyField({ value }: { value: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      input.current?.select();
    }
  }
  return (
    <div className="copy-row">
      <input ref={input} readOnly value={value} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** iPhone only: send step timers to the Clock app through a Shortcut. */
function TimerSetup() {
  const { mode, setMode } = useTimers();
  return (
    <>
      <h3>Timers</h3>
      <p>
        Times in recipe steps (like “simmer 20 minutes”) are buttons that start a timer. The app's
        own timer rings while the app is open (cook mode keeps the screen on). To use the iPhone's
        Clock app instead, so it rings even when locked, set up one more Shortcut:
      </p>
      <ol className="steps">
        <li>
          In <strong>Shortcuts</strong>, tap <strong>+</strong> and name it exactly “{SHORTCUT_NAME}”.
        </li>
        <li>
          Add the action <strong>Start Timer</strong>. Tap its duration, choose the{' '}
          <strong>Shortcut Input</strong> variable, and set the unit to <strong>seconds</strong>.
        </li>
        <li>Turn on the switch below. The first time, iOS asks to allow the Shortcut to run.</li>
      </ol>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={mode === 'shortcut'}
          onChange={(e) => setMode(e.target.checked ? 'shortcut' : 'app')}
        />
        On this phone, start timers in the Clock app
      </label>
    </>
  );
}
