'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ListOrdered, Plus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, Skeleton } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useAgents, useQueues } from '@/lib/hooks';
import type { QueueSummary } from '@/lib/types';

export default function QueuesPage() {
  const queues = useQueues();
  const [editing, setEditing] = React.useState<QueueSummary | 'new' | null>(null);
  return (
    <div>
      <PageHeader
        title="Queues"
        description="Agents only receive leads from queues they belong to. Counts are live; “eligible now” applies consent, do-not-call and attempt rules."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> New queue
          </Button>
        }
      />
      {queues.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : queues.data?.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {queues.data.map((q) => (
            <Card key={q.id}>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {q.name} {q.isDefault && <Badge>Default</Badge>} {!q.active && <Badge tone="warn">Paused</Badge>}
                  </CardTitle>
                  {q.description && <p className="mt-1 text-xs text-muted">{q.description}</p>}
                </div>
                <Button size="sm" variant="outline" onClick={() => setEditing(q)}>
                  Edit
                </Button>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-3 gap-3 text-center sm:grid-cols-6">
                  {[
                    ['Eligible now', q.counts.eligibleNow],
                    ['Ready', q.counts.ready],
                    ['Scheduled', q.counts.scheduled],
                    ['Callbacks', q.counts.callbacks],
                    ['On a call', q.counts.inProgress],
                    ['Finished', q.counts.done],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="text-[11px] text-muted">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums text-ink">{formatNumber(value as number)}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-xs text-muted">
                  {q.members?.length ? `Agents: ${q.members.map((m) => m.name).join(', ')}` : 'No agents assigned: nobody will receive these leads.'}
                  {q.callerId ? ` · Caller ID ${q.callerId}` : ''}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={ListOrdered} title="No queues" />
      )}
      {editing && <QueueDialog queue={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function QueueDialog({ queue, onClose }: { queue: QueueSummary | null; onClose: () => void }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const [name, setName] = React.useState(queue?.name ?? '');
  const [description, setDescription] = React.useState(queue?.description ?? '');
  const [active, setActive] = React.useState(queue?.active ?? true);
  const [callerId, setCallerId] = React.useState(queue?.callerId ?? '');
  const [members, setMembers] = React.useState<Set<string>>(new Set(queue?.members?.map((m) => m.membershipId) ?? []));
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, active, callerId: callerId || null, memberIds: [...members] };
      return queue ? api.patch(`/queues/${queue.id}`, body) : api.post('/queues', body);
    },
    onSuccess: () => {
      toast.success('Queue saved');
      void qc.invalidateQueries({ queryKey: ['queues'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={queue ? `Edit ${queue.name}` : 'New queue'} footer={<Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>Save</Button>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="qn" required>
          <Input id="qn" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="qd">
          <Textarea id="qd" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Caller ID override" htmlFor="qc" hint="Optional. Must be one of your organisation's Plivo numbers, in +91… format.">
          <Input id="qc" value={callerId} onChange={(e) => setCallerId(e.target.value)} placeholder="+914412345678" />
        </Field>
        <Checkbox label="Queue is active" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={queue?.isDefault} />
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Agents</legend>
          <div className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto">
            {agents.map((a) => (
              <Checkbox
                key={a.id}
                label={a.user.name}
                checked={members.has(a.id)}
                onChange={(e) => {
                  const next = new Set(members);
                  if (e.target.checked) next.add(a.id);
                  else next.delete(a.id);
                  setMembers(next);
                }}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
