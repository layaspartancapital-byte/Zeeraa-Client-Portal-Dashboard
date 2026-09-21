import { redirect } from 'next/navigation';
import { PASSWORD_MIN_LENGTH } from '@zeeraa/core';
import { getViewer } from '@/lib/tenant';
import { changeOwnPassword, UserAdminError } from '@/lib/users';
import { createSession } from '@/lib/session';

export const metadata = { title: 'Change password · Zeeraa' };

/**
 * Replacing your own password, and the screen a forced change lands on.
 *
 * Reached two ways: chosen, or sent here by `requireTenant` because
 * `must_change_password` is set. The copy is the only difference — the
 * mechanism is the same, so there is one screen rather than two that can drift.
 *
 * This page deliberately does **not** call `requireTenant`: that is what
 * redirects here, and a page inside its own gate is a loop.
 */
export default async function ChangePassword({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect('/signin?next=/change-password');
  const { error } = await searchParams;
  const forced = viewer.mustChangePassword;

  async function submit(formData: FormData): Promise<void> {
    'use server';
    const current = await getViewer();
    if (!current) redirect('/signin');

    const newPassword = String(formData.get('password') ?? '');
    if (newPassword !== String(formData.get('confirm') ?? '')) {
      redirect('/change-password?error=' + encodeURIComponent('The two passwords do not match.'));
    }

    try {
      await changeOwnPassword({
        userId: current.userId,
        currentPassword: String(formData.get('current') ?? ''),
        newPassword,
      });
    } catch (e) {
      if (e instanceof UserAdminError) {
        redirect('/change-password?error=' + encodeURIComponent(e.message));
      }
      throw e;
    }

    // `changeOwnPassword` ends every session this person holds, including the
    // one making this request — a password change has to invalidate anything
    // obtained under the old one. Issuing a fresh session here is what keeps
    // that from logging them out of the browser they are standing in.
    await createSession(current.userId);
    redirect('/');
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
        <h1 className="text-[22px] font-semibold leading-tight text-text">
          {forced ? 'Choose your own password' : 'Change password'}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-text-2">
          {forced
            ? 'The password you signed in with was set by an administrator and sent to you. Replace it before continuing.'
            : 'Changing this signs you out everywhere else.'}
        </p>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-[8px] border border-[#FECDCA] bg-down-soft px-3 py-2 text-[13px] leading-relaxed text-[#B42318]"
          >
            {error}
          </p>
        )}

        <form className="mt-6 space-y-4" action={submit}>
          {/* Not rendered, but present so a password manager files the new
              password against the right account rather than creating a second
              entry. */}
          <input type="hidden" name="username" autoComplete="username" value={viewer.email} readOnly />

          <div>
            <label htmlFor="current" className="block text-[13px] font-medium text-text-2">
              {forced ? 'The password you were given' : 'Current password'}
            </label>
            <input
              id="current"
              name="current"
              type="password"
              required
              autoComplete="current-password"
              autoFocus
              className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-[13px] font-medium text-text-2">
              New password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="new-password"
              aria-describedby="rule"
              className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
            />
            <p id="rule" className="mt-1.5 text-[12px] text-text-3">
              At least {PASSWORD_MIN_LENGTH} characters. A phrase you can remember beats a short
              one you cannot.
            </p>
          </div>

          <div>
            <label htmlFor="confirm" className="block text-[13px] font-medium text-text-2">
              Repeat new password
            </label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
            />
          </div>

          <button
            type="submit"
            className="h-9 w-full rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
          >
            {forced ? 'Set password and continue' : 'Change password'}
          </button>
        </form>

        {!forced && (
          <a
            href="/"
            className="mt-4 inline-block text-[13px] font-medium text-primary hover:text-primary-600"
          >
            Back to the dashboard
          </a>
        )}
      </div>
    </div>
  );
}
