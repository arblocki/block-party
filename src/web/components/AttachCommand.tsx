import { useRef, useState, type RefObject } from 'react';

function CopyButton({ text, codeRef }: { text: string; codeRef: RefObject<HTMLElement | null> }) {
  const [copied, setCopied] = useState(false);
  const selectText = () => {
    const el = codeRef.current;
    if (el) window.getSelection()?.selectAllChildren(el);
  };
  return (
    <button
      type="button"
      className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-hover"
      onClick={() => {
        // navigator.clipboard is missing on insecure origins (plain-http tailnet).
        let write: Promise<void> | undefined;
        try {
          write = navigator.clipboard?.writeText(text);
        } catch {
          write = undefined;
        }
        if (!write) return selectText();
        write.then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, selectText);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A command the person pastes into a terminal to watch an agent, with a copy button. */
export function AttachCommand({ command }: { command: string }) {
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div className="mt-2">
      <p className="text-xs text-muted">Watch it live — paste this into a terminal:</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          ref={codeRef}
          className="min-w-0 flex-1 overflow-x-auto rounded-md bg-code-bg px-2 py-1 font-mono text-xs"
        >
          {command}
        </code>
        <CopyButton text={command} codeRef={codeRef} />
      </div>
    </div>
  );
}
