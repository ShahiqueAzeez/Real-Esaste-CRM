'use client';
import { GRANTABLE_EXTRA_PERMISSIONS, MEMBERSHIP_ROLES } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Plus, UserPlus } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';
import { AgentStatusBadge, StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Select } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, titleCase } from '@/lib/format';
import { useMembers } from '@/lib/hooks';
import { usePermissions } from '@/lib/session';
import type { Member } from '@/lib/types';

interface TeamRow {
  id: string;
  name: string;
  memberCount: number;
  supervisors: { membershipId: string; name: string }[];
}

function CopyLink({ link, label }: { link: string; label: string }) {
  return (
    <Alert tone="warn" title={label}>
      <p className="mb-2">Email is not configured, so share this link securely (for example in person or over WhatsApp). It works once.</p>
      <div className="flex gap-2">
        <Input readOnly value={link} aria-label="Link" onFocus={(e) => e.target.select()} />
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(link);
            toast.success('Copied');
          }}
        >
          <Copy /> Copy
        </Button>
      </div>
    </Alert>
  );
}

export default function TeamPage() {
  const { can, timezone, me } = usePermissions();
  const qc = useQueryClient();
  const members = useMembers();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => api.get<TeamRow[]>('/teams') });
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => api.get<{ id: string; email: string; role: string; expiresAt: string; createdAt: string }[]>('/invitations'), enabled: can('users:manage') });
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Member | null>(null);
  const [teamEditing, setTeamEditing] = React.useState<TeamRow | 'new' | null>(null);
  const [lastLink, setLastLink] = React.useState<{ link: string; label: string } | null>(null);
  const revoke = useMutation({ mutationFn: (id: string) => api.post(`/invitations/${id}/revoke`), onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }), onError: (e) => toast.error(errorMessage(e)) });
  const resend = useMutation({
    mutationFn: (id: string) => api.post<{ emailDelivered: boolean; inviteLink: string | null }>(`/invitations/${id}/resend`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['invitations'] });
      if (r.inviteLink) setLastLink({ link: r.inviteLink, label: 'New invitation link' });
      else toast.success('Invitation re-sent');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader
        title="Team"
        description="Members, invitations and supervisor teams."
        actions={
          can('users:manage') && (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite member
            </Button>
          )
        }
      />
      {lastLink && (
        <div className="mb-4">
          <CopyLink {...lastLink} />
        </div>
      )}
      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          {can('users:manage') && <TabsTrigger value="invites">Invitations ({invites.data?.length ?? 0})</TabsTrigger>}
          <TabsTrigger value="teams">Teams</TabsTrigger>
        </TabsList>
        <TabsContent value="members">
          <Card>
            <DataTable
              caption="Members"
              rows={members.data}
              loading={members.isLoading}
              onRowClick={can('users:manage') ? (m) => setEditing(m) : undefined}
              columns={[
                {
                  key: 'name',
                  header: 'Name',
                  cell: (m) => (
                    <div>
                      <p className="font-medium text-ink">{m.user.name}</p>
                      <p className="text-xs text-muted">{m.user.email}</p>
                    </div>
                  ),
                },
                { key: 'role', header: 'Role', cell: (m) => titleCase(m.role) },
                { key: 'team', header: 'Team', cell: (m) => m.team?.name ?? '—' },
                { key: 'mode', header: 'Calling', cell: (m) => (m.role === 'AGENT' ? (m.callingMode ? titleCase(m.callingMode) : 'Org default') : '—') },
                { key: 'agent', header: 'Availability', cell: (m) => (m.role === 'AGENT' ? <AgentStatusBadge status={m.agentState?.status} /> : '—') },
                { key: 'status', header: 'Account', cell: (m) => <StatusBadge value={m.status} /> },
                { key: 'login', header: 'Last sign-in', cell: (m) => <span className="text-xs">{formatDateTime(m.user.lastLoginAt, timezone)}</span> },
              ]}
            />
          </Card>
        </TabsContent>
        <TabsContent value="invites">
          <Card>
            <DataTable
              caption="Pending invitations"
              rows={invites.data}
              loading={invites.isLoading}
              empty={<EmptyState title="No pending invitations" />}
              columns={[
                { key: 'email', header: 'Email', cell: (i) => i.email },
                { key: 'role', header: 'Role', cell: (i) => titleCase(i.role) },
                { key: 'exp', header: 'Expires', cell: (i) => formatDateTime(i.expiresAt, timezone) },
                {
                  key: 'actions',
                  header: '',
                  className: 'text-right',
                  cell: (i) => (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => resend.mutate(i.id)}>
                        Resend
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>
                        Revoke
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </TabsContent>
        <TabsContent value="teams">
          <div className="mb-3 flex justify-end">
            {can('teams:manage') && (
              <Button variant="outline" onClick={() => setTeamEditing('new')}>
                <Plus /> New team
              </Button>
            )}
          </div>
          <Card>
            <DataTable
              caption="Teams"
              rows={teams.data}
              loading={teams.isLoading}
              onRowClick={can('teams:manage') ? (t) => setTeamEditing(t) : undefined}
              empty={<EmptyState title="No teams yet" description="Teams decide which agents a supervisor can see and coach." />}
              columns={[
                { key: 'name', header: 'Team', cell: (t) => <span className="font-medium text-ink">{t.name}</span> },
                { key: 'members', header: 'Agents', cell: (t) => t.memberCount },
                { key: 'sup', header: 'Supervisors', cell: (t) => t.supervisors.map((s) => s.name).join(', ') || '—' },
              ]}
            />
          </Card>
        </TabsContent>
      </Tabs>
      {inviteOpen && <InviteDialog teams={teams.data ?? []} onClose={() => setInviteOpen(false)} onLink={setLastLink} />}
      {editing && <MemberDialog member={editing} teams={teams.data ?? []} self={editing.id === me?.membership?.id} onClose={() => setEditing(null)} onLink={setLastLink} />}
      {teamEditing && <TeamDialog team={teamEditing === 'new' ? null : teamEditing} members={members.data ?? []} onClose={() => setTeamEditing(null)} />}
    </div>
  );
}

function InviteDialog({ teams, onClose, onLink }: { teams: TeamRow[]; onClose: () => void; onLink: (l: { link: string; label: string }) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState('AGENT');
  const [teamId, setTeamId] = React.useState('');
  const invite = useMutation({
    mutationFn: () => api.post<{ emailDelivered: boolean; inviteLink: string | null }>('/invitations', { email, role, teamId: teamId || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['invitations'] });
      if (r.inviteLink) onLink({ link: r.inviteLink, label: `Invitation link for ${email}` });
      else toast.success(`Invitation emailed to ${email}`);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Invite a member" description="Invitations expire after 7 days. Agents count towards your plan's agent limit when they join." footer={<Button loading={invite.isPending} disabled={!email} onClick={() => invite.mutate()}>Send invitation</Button>}>
      <div className="space-y-4">
        <Field label="Email" htmlFor="inv-email" required>
          <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="inv-role">
          <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {MEMBERSHIP_ROLES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        {role === 'AGENT' && (
          <Field label="Team" htmlFor="inv-team">
            <Select id="inv-team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function MemberDialog({ member, teams, self, onClose, onLink }: { member: Member; teams: TeamRow[]; self: boolean; onClose: () => void; onLink: (l: { link: string; label: string }) => void }) {
  const qc = useQueryClient();
  const [v, setV] = React.useState({
    role: member.role,
    status: member.status,
    teamId: member.team?.id ?? '',
    callingMode: member.callingMode ?? '',
    agentPhone: member.agentPhoneE164 ?? '',
    telephonyIdentity: member.telephonyIdentity,
    extraPermissions: new Set(member.extraPermissions),
  });
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/members/${member.id}`, {
        role: v.role,
        status: v.status,
        teamId: v.teamId || null,
        callingMode: v.callingMode || null,
        agentPhone: v.agentPhone || null,
        telephonyIdentity: v.telephonyIdentity,
        extraPermissions: [...v.extraPermissions],
      }),
    onSuccess: () => {
      toast.success('Member updated');
      void qc.invalidateQueries({ queryKey: ['members'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const resetLink = useMutation({
    mutationFn: () => api.post<{ link: string }>(`/members/${member.id}/reset-link`),
    onSuccess: (r) => {
      onLink({ link: r.link, label: `Password reset link for ${member.user.name} (valid 60 minutes)` });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={member.user.name}
      description={member.user.email}
      wide
      footer={
        <>
          <Button variant="outline" onClick={() => resetLink.mutate()} loading={resetLink.isPending}>
            Create reset link
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Role" htmlFor="m-role" hint={self ? 'You cannot change your own role' : undefined}>
          <Select id="m-role" value={v.role} disabled={self} onChange={(e) => setV((s) => ({ ...s, role: e.target.value as Member['role'] }))}>
            {MEMBERSHIP_ROLES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account" htmlFor="m-status" hint="Deactivating signs the member out immediately">
          <Select id="m-status" value={v.status} disabled={self} onChange={(e) => setV((s) => ({ ...s, status: e.target.value as Member['status'] }))}>
            <option value="ACTIVE">Active</option>
            <option value="DEACTIVATED">Deactivated</option>
          </Select>
        </Field>
        <Field label="Team" htmlFor="m-team">
          <Select id="m-team" value={v.teamId} onChange={(e) => setV((s) => ({ ...s, teamId: e.target.value }))}>
            <option value="">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {v.role === 'AGENT' && (
          <>
            <Field label="Calling mode" htmlFor="m-mode" hint="Phone mode rings the agent's mobile instead of the browser">
              <Select id="m-mode" value={v.callingMode} onChange={(e) => setV((s) => ({ ...s, callingMode: e.target.value }))}>
                <option value="">Organisation default</option>
                <option value="BROWSER">Browser</option>
                <option value="PHONE">Phone</option>
              </Select>
            </Field>
            <Field label="Agent phone" htmlFor="m-phone" hint="Required for phone mode">
              <Input id="m-phone" value={v.agentPhone} onChange={(e) => setV((s) => ({ ...s, agentPhone: e.target.value }))} placeholder="+91 98400 12345" />
            </Field>
            <Field label="Telephony identity" htmlFor="m-ident" hint="Browser registration name. Change only if Plivo requires a pre-created endpoint username.">
              <Input id="m-ident" value={v.telephonyIdentity} onChange={(e) => setV((s) => ({ ...s, telephonyIdentity: e.target.value }))} />
            </Field>
          </>
        )}
        {v.role === 'SUPERVISOR' && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium text-ink">Extra permissions</legend>
            <div className="grid grid-cols-2 gap-2">
              {GRANTABLE_EXTRA_PERMISSIONS.map((p) => (
                <Checkbox
                  key={p}
                  label={titleCase(p.replace(/:/g, '_'))}
                  checked={v.extraPermissions.has(p)}
                  onChange={(e) =>
                    setV((s) => {
                      const next = new Set(s.extraPermissions);
                      if (e.target.checked) next.add(p);
                      else next.delete(p);
                      return { ...s, extraPermissions: next };
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

function TeamDialog({ team, members, onClose }: { team: TeamRow | null; members: Member[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = React.useState(team?.name ?? '');
  const [sups, setSups] = React.useState<Set<string>>(new Set(team?.supervisors.map((s) => s.membershipId) ?? []));
  const candidates = members.filter((m) => (m.role === 'SUPERVISOR' || m.role === 'ORG_ADMIN') && m.status === 'ACTIVE');
  const save = useMutation({
    mutationFn: () => (team ? api.patch(`/teams/${team.id}`, { name, supervisorIds: [...sups] }) : api.post('/teams', { name, supervisorIds: [...sups] })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/teams/${team!.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={team ? `Edit ${team.name}` : 'New team'}
      description="Assign agents to teams from their member settings."
      footer={
        <>
          {team && (
            <Button variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending}>
              Delete team
            </Button>
          )}
          <Button loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="t-name" required>
          <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">Supervisors</legend>
          <div className="grid grid-cols-2 gap-2">
            {candidates.map((m) => (
              <Checkbox
                key={m.id}
                label={m.user.name}
                checked={sups.has(m.id)}
                onChange={(e) => {
                  const next = new Set(sups);
                  if (e.target.checked) next.add(m.id);
                  else next.delete(m.id);
                  setSups(next);
                }}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}
