'use client';
import { Play } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { Button } from './ui/button';

/** Fetches a 5-minute signed playback URL on demand; the provider URL never reaches the browser. */
export function RecordingPlayer({ recordingId, durationSeconds }: { recordingId: string; durationSeconds: number | null }) {
  const [src, setSrc] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  if (src) return <audio controls autoPlay src={src} className="h-8 w-full max-w-xs" onError={() => setSrc(null)} />;
  return (
    <Button
      size="sm"
      variant="outline"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api.post<{ url: string }>(`/recordings/${recordingId}/playback`);
          setSrc(r.url);
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Play /> Recording {durationSeconds ? `(${formatDuration(durationSeconds)})` : ''}
    </Button>
  );
}
