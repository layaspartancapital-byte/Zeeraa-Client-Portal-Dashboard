import { ZeeraaMark } from '@/components/shell/ZeeraaMark';

/**
 * The frame for the screens that sit outside the application shell.
 *
 * Sign-in and the forced password change have no rail and no title band, so
 * before the rebrand they were the only screens carrying no identity at all —
 * and they are the first thing anybody sees. The chrome that the rail and the
 * title band provide elsewhere is provided here by the page itself.
 *
 * **The same division as everywhere else: chrome carries the identity, the
 * light card carries the controls.** The form sits on `--color-surface` because
 * a password field on near-black is a worse password field, and these are the
 * two screens where a mistyped character costs the most. Nothing here is a new
 * treatment; it is the shell's rule applied to a page that has no shell.
 */
export function AuthShell({
  children,
  footnote,
}: {
  children: React.ReactNode;
  /** One line under the card, on the chrome. Optional. */
  footnote?: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-chrome px-4 py-16 sm:px-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <ZeeraaMark height={40} />
        </div>

        <div className="card p-6 sm:p-8">{children}</div>

        {footnote && (
          <p className="mt-5 text-center text-[12px] leading-relaxed text-on-chrome-3">
            {footnote}
          </p>
        )}
      </div>
    </div>
  );
}
