import { logout } from '../api';

/** Ends this device's session (clears the cookie), then reloads to the login screen. */
export function LogoutButton() {
  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-hover"
      onClick={() => void logout().finally(() => location.reload())}
    >
      Log out
    </button>
  );
}
