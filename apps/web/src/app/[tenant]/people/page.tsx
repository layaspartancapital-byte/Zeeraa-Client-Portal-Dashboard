import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assignableRoles, canManageUsers, ROLE_LABELS, type Role } from '@zeeraa/core';
import { Card, CardBody, CardHeader, Grid } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InfoTip } from '@/components/ui/InfoTip';
import { TopBar } from '@/components/shell/TopBar';
import { CopyButton } from '@/components/CopyButton';
import { clearHandover, readHandover, setHandover } from '@/lib/handover';
import { requireRole } from '@/lib/tenant';
import {
  createUser,
  grantMembership,
  resetPassword,
  revokeMembership,
  tenantRoster,
  UserAdminError,
  type RosterEntry,
} from '@/lib/users';

export const metadata = { title: 'People' };

/**
 * Who can open this engagement, and the two things an admin does about it.
 *
 * There is no email in this product, so a password arrives the way any other
 * shared secret does: an admin reads it out. This screen is built around that
 * — it shows a generated password **once**, says plainly that it cannot be
 * shown again, and offers a reset rather than a recovery, because a recovery
 * flow needs a mailbox nobody here is sending to.
 *
 * A client admin sees the same screen as a Zeeraa admin, minus the Zeeraa roles
 * in the role picker. The picker is presentation; `memberships_admin_write` is
 * what actually refuses.
 */
/**
 * Re-renders the page with a message.
 *
 * Declared here rather than inside the component on purpose. A server action
 * that closes over a value has those values encrypted and shipped as bound
 * arguments, and a *function* cannot be encrypted — React responds by dropping
 * the progressive-enhancement fallback and rendering
 * `action="javascript:throw ..."`, so every form on the page silently stops
 * working without JavaScript. At module scope this is not captured at all.
 *
 * **Nothing secret goes through here.** A generated password travels in a
 * cookie (`lib/handover.ts`); what this carries is a notice or an error, which
 * are fine in a URL and useful in one — they survive a refresh and can be
 * linked to. `redirect` throws, so every call is the end of its action.
 *
 * **The fragment is not decoration.** These messages render at the top of the
 * page and the forms that produce them are at the bottom, past the roster. When
 * the redirect target differed from the current URL the browser reset the
 * scroll and the message was the first thing in view; once the password moved
 * out of the query string the target became the same URL the admin was already
 * on, scroll position was preserved, and the result appeared off-screen above
 * them. An anchor puts the message in view whichever way the navigation is
 * treated, and it works without JavaScript.
 */
function back(slug: string, params: Record<string, string>, fragment = '#message'): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`/${slug}/people${qs ? `?${qs}` : ''}${fragment}`);
}

export default async function People({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { tenant: slug } = await params;
  const session = await requireRole(slug, canManageUsers);
  const query = await searchParams;

  const [roster, handover] = await Promise.all([tenantRoster(session), readHandover()]);
  const grantable = assignableRoles(session.tenant.role);

  /**
   * Every action ends by redirecting, and `redirect` works by throwing. So the
   * redirect is outside the `try` — inside it, the control-flow exception is
   * caught by the `catch` that is looking for a `UserAdminError`, and survives
   * only because the fallthrough rethrows it. That is one edit away from an
   * action that silently does nothing.
   */
  async function create(formData: FormData): Promise<void> {
    'use server';
    const s = await requireRole(slug, canManageUsers);
    let outcome: { email: string; initialPassword: string };
    try {
      outcome = await createUser(s, {
        email: String(formData.get('email') ?? ''),
        name: String(formData.get('name') ?? ''),
        title: String(formData.get('title') ?? ''),
        role: String(formData.get('role') ?? '') as Role,
      });
    } catch (e) {
      if (e instanceof UserAdminError) back(slug, { error: e.message });
      throw e;
    }
    await setHandover(slug, {
      kind: 'created',
      email: outcome.email,
      password: outcome.initialPassword,
    });
    revalidatePath(`/${slug}/people`);
    back(slug, {}, '#handover');
  }

  async function grant(formData: FormData): Promise<void> {
    'use server';
    const s = await requireRole(slug, canManageUsers);
    const email = String(formData.get('email') ?? '').trim().toLowerCase();
    try {
      await grantMembership(s, { email, role: String(formData.get('role') ?? '') as Role });
    } catch (e) {
      if (e instanceof UserAdminError) back(slug, { error: e.message });
      throw e;
    }
    revalidatePath(`/${slug}/people`);
    // This used to redirect with nothing at all. Granting access succeeded
    // silently: the page reloaded, the roster gained a row somewhere in the
    // middle, and nothing said the thing you asked for had happened.
    back(slug, { notice: `${email} now has access to this engagement.` });
  }

  async function reset(formData: FormData): Promise<void> {
    'use server';
    const s = await requireRole(slug, canManageUsers);
    let outcome: { email: string; initialPassword: string };
    try {
      outcome = await resetPassword(s, String(formData.get('userId') ?? ''));
    } catch (e) {
      if (e instanceof UserAdminError) back(slug, { error: e.message });
      throw e;
    }
    await setHandover(slug, {
      kind: 'reset',
      email: outcome.email,
      password: outcome.initialPassword,
    });
    revalidatePath(`/${slug}/people`);
    back(slug, {}, '#handover');
  }

  async function revoke(formData: FormData): Promise<void> {
    'use server';
    const s = await requireRole(slug, canManageUsers);
    const userId = String(formData.get('userId') ?? '');
    const person = roster.find((r) => r.userId === userId);
    try {
      await revokeMembership(s, userId);
    } catch (e) {
      if (e instanceof UserAdminError) back(slug, { error: e.message });
      throw e;
    }
    revalidatePath(`/${slug}/people`);
    back(slug, {
      notice: `${person?.email ?? 'That person'} no longer has access to this engagement.`,
    });
  }

  /** Puts the handover away deliberately, rather than on the next navigation. */
  async function dismiss(): Promise<void> {
    'use server';
    await requireRole(slug, canManageUsers);
    await clearHandover(slug);
    back(slug, {}, '');
  }

  return (
    <>
      <TopBar tenant={session.tenant} viewer={session.viewer} title="People" />

      <Grid>
        {query.error && (
          <Card span={12} id="message" className="scroll-mt-24 border-[#FECDCA]">
            <CardBody className="pt-5">
              <p role="alert" className="text-[13px] leading-relaxed text-[#B42318]">
                {query.error}
              </p>
            </CardBody>
          </Card>
        )}

        {query.notice && (
          <Card span={12} id="message" className="scroll-mt-24">
            <CardBody className="pt-5">
              <p role="status" className="text-[13px] leading-relaxed text-text-2">
                {query.notice}
              </p>
            </CardBody>
          </Card>
        )}

        {/*
          The handover, first on the page and drawn in the accent so it cannot
          be mistaken for another row of the roster. It is the only thing on
          this screen that cannot be recovered by looking again.
        */}
        {handover && (
          <Card span={12} id="handover" className="scroll-mt-24 border-primary">
            <CardHeader
              title={handover.kind === 'created' ? 'Account created' : 'Password reset'}
              subtitle={`Give this password to ${handover.email} directly — it is not sent to them.`}
              controls={
                <form action={dismiss}>
                  <button
                    type="submit"
                    className="h-8 rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-canvas hover:text-text"
                  >
                    Done
                  </button>
                </form>
              }
            />
            <CardBody>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all rounded-[8px] border border-primary-100 bg-primary-100/40 px-3 py-2.5 font-mono text-[16px] font-semibold tracking-tight text-text">
                  {handover.password}
                </code>
                <CopyButton value={handover.password} label="Copy the password" />
              </div>
              <p className="mt-2.5 text-[12px] leading-relaxed text-text-3">
                They will be required to replace it when they sign in. Nothing stores it in
                readable form, so if it is lost the only way forward is another reset — this panel
                stays until you choose Done.
              </p>
            </CardBody>
          </Card>
        )}

        <Card span={12}>
          <CardHeader
            title="People in this engagement"
            subtitle={`${roster.length} ${roster.length === 1 ? 'person' : 'people'}`}
            info={
              <InfoTip label="How access works" align="start">
                Access is a membership row, so removing somebody here ends their access to this
                engagement on their next request. The account itself survives, because it may hold
                other engagements.
              </InfoTip>
            }
          />
          <CardBody flush>
            <div className="scroll-x relative min-w-0 overflow-x-auto px-5 pb-1">
              <table className="w-full min-w-[720px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-[12px] text-text-3">
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium">Password</th>
                    <th className="py-2 pr-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roster.map((person) => (
                    <PersonRow
                      key={person.userId}
                      person={person}
                      isSelf={person.userId === session.viewer.userId}
                      reset={reset}
                      revoke={revoke}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>

        <Card span={6}>
          <CardHeader
            title="Create an account"
            subtitle="Generates a password for you to pass on"
          />
          <CardBody>
            <form className="space-y-3" action={create}>
              <Field name="name" label="Name" autoComplete="off" required />
              <Field name="email" label="Email" type="email" autoComplete="off" required />
              <Field name="title" label="Job title (optional)" autoComplete="off" />
              <RoleSelect roles={grantable} />
              <button
                type="submit"
                className="h-9 w-full rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
              >
                Create account
              </button>
            </form>
          </CardBody>
        </Card>

        <Card span={6}>
          <CardHeader
            title="Add an existing account"
            subtitle="For somebody who already has one"
            info={
              <InfoTip label="Why this is separate" align="end">
                Creating an account and granting it access are two acts. Somebody joining a second
                engagement already has an account, and a second one would give them two passwords
                and two histories.
              </InfoTip>
            }
          />
          <CardBody>
            <form className="space-y-3" action={grant}>
              <Field name="email" label="Email" type="email" autoComplete="off" required />
              <RoleSelect roles={grantable} />
              <button
                type="submit"
                className="h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[13px] font-semibold text-text transition-colors hover:bg-canvas"
              >
                Grant access
              </button>
            </form>
            {session.tenant.role === 'client_admin' && (
              <p className="mt-3 text-[12px] leading-relaxed text-text-3">
                An address held in another engagement will not be found here. Ask Zeeraa to add
                them.
              </p>
            )}
          </CardBody>
        </Card>
      </Grid>
    </>
  );
}

function PersonRow({
  person,
  isSelf,
  reset,
  revoke,
}: {
  person: RosterEntry;
  isSelf: boolean;
  reset: (formData: FormData) => Promise<void>;
  revoke: (formData: FormData) => Promise<void>;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2.5 pr-3">
        <span className="block font-medium text-text">{person.name ?? person.email}</span>
        <span className="block text-[12px] text-text-3">{person.email}</span>
      </td>
      <td className="py-2.5 pr-3">
        <Badge tone="neutral">{ROLE_LABELS[person.role]}</Badge>
      </td>
      <td className="py-2.5 pr-3">
        {!person.hasPassword ? (
          <Badge tone="warn">
            Cannot sign in
            <InfoTip label="Why this account cannot sign in" align="center">
              No password has ever been set on this account. Reset it to issue one.
            </InfoTip>
          </Badge>
        ) : person.mustChangePassword ? (
          <Badge tone="warn">Must change</Badge>
        ) : (
          <span className="text-[12px] tabular text-text-3">
            Set {person.passwordUpdatedAt?.toLocaleDateString('en-US', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <div className="flex flex-wrap justify-end gap-2">
          <form action={reset}>
            <input type="hidden" name="userId" value={person.userId} />
            <button
              type="submit"
              className="h-8 rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-canvas hover:text-text"
            >
              Reset password
            </button>
          </form>
          {/* No self-revocation: an admin removing their own access would leave
              an engagement nobody in it can administer. */}
          {!isSelf && (
            <form action={revoke}>
              <input type="hidden" name="userId" value={person.userId} />
              <button
                type="submit"
                className="h-8 rounded-[8px] border border-border bg-surface px-2.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-down-soft hover:text-[#B42318]"
              >
                Remove
              </button>
            </form>
          )}
        </div>
      </td>
    </tr>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required = false,
  autoComplete,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-[13px] font-medium text-text-2">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
      />
    </div>
  );
}

function RoleSelect({ roles }: { roles: readonly Role[] }) {
  return (
    <div>
      <label htmlFor="role" className="block text-[13px] font-medium text-text-2">
        Role
      </label>
      <select
        id="role"
        name="role"
        required
        defaultValue={roles[roles.length - 1]}
        className="mt-1.5 h-9 w-full rounded-[8px] border border-border bg-surface px-3 text-[14px] text-text"
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {ROLE_LABELS[role]}
          </option>
        ))}
      </select>
    </div>
  );
}
