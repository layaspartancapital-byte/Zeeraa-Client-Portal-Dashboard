export const metadata = { title: 'Check your email · Zeeraa' };

export default function CheckEmail() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-16 sm:px-6">
      <div className="card p-6 sm:p-8">
      <h1 className="text-[22px] font-semibold text-text">Check your email</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-text-2">
        A sign-in link is on its way. It works once and expires in 24 hours. If it
        has not arrived in a few minutes, check the spam folder, then request
        another.
      </p>
      <a href="/signin" className="mt-6 inline-block text-[13px] font-medium text-primary hover:text-primary-600">
        Back to sign in
      </a>
      </div>
    </div>
  );
}
