'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileUp, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/page';
import { DataTable } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePermissions } from '@/lib/session';
import { cn } from '@/lib/utils';

interface ImportRow {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  importedRows: number;
  updatedRows: number;
  createdAt: string;
}

export default function ImportsPage() {
  const router = useRouter();
  const { timezone } = usePermissions();
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['imports'], queryFn: () => api.get<ImportRow[]>('/imports') });
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ id: string }>('/imports', file),
    onSuccess: (r) => router.push(`/imports/${r.id}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) return toast.error('Choose a .csv file');
    if (file.size > 20 * 1024 * 1024) return toast.error('Files are limited to 20 MB. Split larger lists.');
    upload.mutate(file);
  };
  return (
    <div>
      <PageHeader title="Import leads" description="Upload a CSV, map its columns, review a validation preview, then import. Nothing is added until you confirm." />
      <Card className="mb-6">
        <CardContent>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              pick(e.dataTransfer.files[0]);
            }}
            className={cn('flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 text-center', dragging ? 'border-brand bg-brand-soft/40' : 'border-line-strong')}
          >
            <FileUp className="mb-2 size-8 text-muted" />
            <p className="text-sm font-medium text-ink">Drop a CSV file here</p>
            <p className="mt-1 text-xs text-muted">First row must be column names. Up to 100,000 rows and 20 MB. Phone numbers can be in local or international format.</p>
            <input ref={inputRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label="Choose CSV file" />
            <Button className="mt-4" onClick={() => inputRef.current?.click()} loading={upload.isPending}>
              <Upload /> Choose file
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
        </CardHeader>
        <DataTable
          caption="Imports"
          rows={list.data}
          loading={list.isLoading}
          onRowClick={(r) => router.push(`/imports/${r.id}`)}
          empty={<EmptyState title="No imports yet" description="Your uploaded files will appear here." />}
          columns={[
            { key: 'file', header: 'File', cell: (r) => <span className="font-medium text-ink">{r.fileName}</span> },
            { key: 'status', header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
            { key: 'rows', header: 'Rows', cell: (r) => formatNumber(r.totalRows), className: 'text-right' },
            { key: 'valid', header: 'Valid', cell: (r) => formatNumber(r.validRows), className: 'text-right' },
            { key: 'invalid', header: 'Problems', cell: (r) => formatNumber(r.invalidRows), className: 'text-right' },
            { key: 'imported', header: 'Added / updated', cell: (r) => `${formatNumber(r.importedRows)} / ${formatNumber(r.updatedRows)}`, className: 'text-right' },
            { key: 'created', header: 'Uploaded', cell: (r) => formatDateTime(r.createdAt, timezone) },
          ]}
        />
      </Card>
    </div>
  );
}
