import { HOME_HREF, NEW_RUN_HREF, REPOS_HREF } from '../lib/route';
import { LogoutButton } from './LogoutButton';

/** Small uppercase heading text; section headings add the gap below. */
export const headingText = 'text-sm font-semibold uppercase text-muted';
export const sectionHeading = `mb-2 ${headingText}`;

/** A link (or button) styled as a small bordered button. */
export const linkButton =
  'rounded-md border border-line bg-surface-elevated px-2.5 py-1 text-sm hover:bg-surface-hover disabled:opacity-50';

/** Top bar shared by the home page, the run view and the new-run form. */
export function TopBar() {
  return (
    <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <a href={HOME_HREF} className="text-lg font-semibold">
        block-party
      </a>
      <span className="flex-1" />
      <a href={NEW_RUN_HREF} className={linkButton}>
        New run
      </a>
      <a href={REPOS_HREF} className={linkButton}>
        Repositories
      </a>
      <LogoutButton />
    </div>
  );
}
