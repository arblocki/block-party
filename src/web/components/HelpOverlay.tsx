import { SHORTCUTS } from '../lib/keyboard';

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 sm:pt-24"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      data-testid="help-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button type="button" className="text-muted" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <dl className="space-y-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-3">
              <dt className="w-20 shrink-0">
                <kbd className="rounded-md border border-line bg-surface-elevated px-1.5 py-0.5 font-mono text-xs">
                  {s.keys}
                </kbd>
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">
          Shortcuts are off while you type in a comment box.
        </p>
      </div>
    </div>
  );
}
