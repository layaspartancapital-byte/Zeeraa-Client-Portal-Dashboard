import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

/**
 * One family throughout (spec v2 §5). Inter, with tabular numerals switched on
 * at every numeric site by the `.numeric` / `.tabular` utilities rather than
 * globally, so proportional digits still apply inside running text.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Zeeraa performance platform',
  description: 'Marketing performance, delivery and approvals.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
