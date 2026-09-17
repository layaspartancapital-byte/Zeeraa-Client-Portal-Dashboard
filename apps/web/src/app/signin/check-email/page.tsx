export const metadata = { title: 'Check your email · Zeeraa' };

export default function CheckEmail() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-[24px] text-ink">Check your email</h1>
      <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-graphite">
        A sign-in link is on its way. It works once and expires in 24 hours. If it
        has not arrived in a few minutes, check the spam folder, then request
        another.
      </p>
      <a href="/signin" className="mt-6 text-[13px] text-brass underline underline-offset-2">
        Back to sign in
      </a>
    </div>
  );
}
