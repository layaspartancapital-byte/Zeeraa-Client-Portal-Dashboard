import { redirect } from 'next/navigation';
import { defaultTenantSlug, getViewer } from '@/lib/tenant';

export default async function Home() {
  const viewer = await getViewer();
  if (!viewer) redirect('/signin');
  if (viewer.mustChangePassword) redirect('/change-password');
  const slug = await defaultTenantSlug();
  redirect(slug ? `/${slug}` : '/no-access');
}
