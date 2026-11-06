import type { Metadata, Viewport } from 'next';
import { Providers } from '@/lib/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Calling CRM', template: `%s · ${process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Calling CRM'}` },
  description: 'Outbound calling CRM for real estate teams',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-sm">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
