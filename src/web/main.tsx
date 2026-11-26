import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, initToken } from './api';
import { App } from './App';
import { Login } from './components/Login';
import 'react-diff-view/style/index.css';
import './index.css';

initToken();

/** Probes `/api/health`: a 401 (no valid token or session cookie) shows the login screen. */
function Root() {
  const [state, setState] = useState<'checking' | 'login' | 'ready'>('checking');
  useEffect(() => {
    api('/api/health').then(
      () => setState('ready'),
      // Any other failure still renders App, which shows its own error and Retry.
      (err: unknown) => setState(err instanceof ApiError && err.status === 401 ? 'login' : 'ready'),
    );
  }, []);
  if (state === 'checking') return <p className="p-8 text-muted">Loading…</p>;
  return state === 'login' ? <Login /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
