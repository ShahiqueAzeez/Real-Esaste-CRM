import { PhoneCall } from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/utils';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2 text-ink">
        <span className="grid size-9 place-items-center rounded-lg bg-brand text-white">
          <PhoneCall className="size-5" aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
      </div>
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">{children}</div>
      <p className="mt-6 max-w-sm text-center text-xs text-muted">For authorised staff of subscribing organisations. Activity is logged.</p>
    </main>
  );
}
