import { useState, type FormEvent } from 'react';
import { ApiError, login } from '../api';

/** Shown when the server rejects us (no token, no session cookie): paste the token once. */
export function Login() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await login(value);
      location.reload();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Wrong token' : 'Login failed');
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm p-8">
      <h1 className="mb-1 text-lg font-semibold">block-party</h1>
      <p className="mb-4 text-sm text-muted">Paste the access token to use this device.</p>
      <form onSubmit={(e) => void submit(e)}>
        {/* Lets password managers (iOS Keychain, LastPass) offer to save the token. */}
        <input type="hidden" name="username" autoComplete="username" value="block-party" />
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Access token"
          placeholder="Token"
          className="mb-3 w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
        />
        {error && (
          <p role="alert" className="mb-3 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
