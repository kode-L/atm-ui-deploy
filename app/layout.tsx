import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL || 'http://localhost:3000'),
  title: 'Daily PR Boost Manager',
  description: 'Interact with Daily PR Boost Manager on BNB Smart Chain (Testnet or Mainnet)',
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
  openGraph: { images: ['/og-image.png'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script src="https://apps.abacus.ai/chatllm/appllm-lib.js" />
      </head>
      <body className="min-h-screen bg-surface-primary text-txt-primary">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
