'use client';
import type { TenantSettings, TenantSettingsPatch } from '@crm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from './api';

export function useOrgSettings() {
  return useQuery({ queryKey: ['org', 'settings'], queryFn: () => api.get<TenantSettings>('/org/settings') });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: TenantSettingsPatch) => api.patch<TenantSettings>('/org/settings', patch),
    onSuccess: (s) => {
      qc.setQueryData(['org', 'settings'], s);
      toast.success('Settings saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}
