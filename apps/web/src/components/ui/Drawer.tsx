'use client';

import { useEffect, useState } from 'react';
import { BookOpen, X } from 'lucide-react';

export type MethodNote = {
  heading: string;
  body: string;
  /** Rendered as a muted line under the body — a dependency, a date, a source. */
  detail?: string;
};

/**
 * "How this is measured".
 *
 * The one place on a screen where more than two sentences may appear. Spec v2
 * §2 moves every methodology note, definition and caveat out of the layout and
 * into an ⓘ, a status badge or this drawer; it opens from a single link in the
 * page header and holds the full explanations for the whole screen.
 *
 * The notes are also rendered, collapsed, into the print sheet: on paper there
 * is no drawer to open, and a quarterly review that carries the figures without
 * their definitions is the dispute this product exists to prevent.
 */
export function MethodDrawer({ notes, title }: { notes: MethodNote[]; title: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  if (notes.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="link inline-flex items-center gap-1.5 text-[13px] print-hidden"
      >
        <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
        How this is measured
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] print-hidden">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-[rgba(16,24,40,0.35)]"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`How this is measured — ${title}`}
            className="absolute inset-y-0 right-0 flex w-[min(30rem,100vw)] flex-col bg-surface shadow-[var(--shadow-pop)]"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold text-text">How this is measured</h2>
                <p className="mt-0.5 text-[13px] text-text-2">{title}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-text-2 hover:bg-canvas hover:text-text"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              <dl className="space-y-5">
                {notes.map((note) => (
                  <div key={note.heading}>
                    <dt className="text-[13px] font-semibold text-text">{note.heading}</dt>
                    <dd className="mt-1 text-[13px] leading-relaxed text-text-2">{note.body}</dd>
                    {note.detail && (
                      <dd className="mt-1 text-[12px] leading-relaxed text-text-3">
                        {note.detail}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The same notes, printed. Hidden on screen; expanded on paper. */
export function MethodNotesForPrint({ notes }: { notes: MethodNote[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="hidden print:block">
      <h2 className="text-[13px] font-semibold">How this is measured</h2>
      <dl className="mt-2 space-y-2">
        {notes.map((note) => (
          <div key={note.heading}>
            <dt className="text-[11px] font-semibold">{note.heading}</dt>
            <dd className="text-[11px] leading-snug">
              {note.body}
              {note.detail ? ` ${note.detail}` : ''}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
