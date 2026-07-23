import type { UploadedFile } from '@jarvis/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertCircle, FileText, Loader2, Trash2, UploadCloud, X } from 'lucide-react';
import type { DragEvent } from 'react';
import { useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, LoadingPane, Modal, PageHeader } from '../components/ui.js';
import { api } from '../lib/api.js';
import { fileSize, timeAgo } from '../lib/format.js';

type UploadProgress = {
  id: number;
  name: string;
  status: 'queued' | 'uploading' | 'error';
  error?: string;
};

function StatusBadge({ file }: { file: UploadedFile }) {
  if (file.status === 'processing') {
    return (
      <Badge tone="amber">
        <Loader2 className="h-3 w-3 animate-spin" />
        Processing
      </Badge>
    );
  }
  if (file.status === 'error') {
    return (
      <span title={file.extractionError ?? 'Text extraction failed'}>
        <Badge tone="red">Error</Badge>
      </span>
    );
  }
  return <Badge tone="green">Ready</Badge>;
}

function ViewTextModal({ file, onClose }: { file: UploadedFile | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['upload-text', file?.id],
    queryFn: () => api.get<{ text: string | null }>(`/api/uploads/${file?.id}/text`),
    enabled: !!file,
  });
  return (
    <Modal open={!!file} onClose={onClose} title={file?.filename ?? 'Extracted text'} wide>
      {isLoading ? (
        <LoadingPane label="Loading text…" />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed bg-surface-sunken rounded-lg p-4 max-h-[60vh] overflow-y-auto">
          {data?.text ?? 'No text was extracted from this file.'}
        </pre>
      )}
    </Modal>
  );
}

/** /files — drag-and-drop uploads plus the uploaded-file library. */
export function FilesPage() {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [viewing, setViewing] = useState<UploadedFile | null>(null);

  const files = useQuery({
    queryKey: ['uploads'],
    queryFn: () => api.get<{ items: UploadedFile[] }>('/api/uploads'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/uploads/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['uploads'] });
    },
  });

  async function handleFiles(fileList: FileList | File[]) {
    const picked = Array.from(fileList);
    if (picked.length === 0) return;
    const startId = Date.now() + Math.random();
    const entries: UploadProgress[] = picked.map((f, i) => ({
      id: startId + i,
      name: f.name,
      status: 'queued',
    }));
    setProgress((p) => [...p, ...entries]);
    // Upload sequentially so each file gets a clear progress row.
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      const entry = entries[i];
      if (!file || !entry) continue;
      setProgress((p) => p.map((e) => (e.id === entry.id ? { ...e, status: 'uploading' } : e)));
      try {
        await api.upload<{ file: UploadedFile }>('/api/uploads', file);
        setProgress((p) => p.filter((e) => e.id !== entry.id));
        qc.invalidateQueries({ queryKey: ['uploads'] });
      } catch (err) {
        setProgress((p) =>
          p.map((e) =>
            e.id === entry.id
              ? { ...e, status: 'error', error: err instanceof Error ? err.message : 'Upload failed' }
              : e,
          ),
        );
      }
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    void handleFiles(e.dataTransfer.files);
  };

  const onDelete = (file: UploadedFile) => {
    if (window.confirm(`Delete ${file.filename}? Jarvis will forget its contents.`)) {
      remove.mutate(file.id);
    }
  };

  const items = files.data?.items ?? [];

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <PageHeader
        title="Uploaded files"
        subtitle="Uploaded files are first-class sources: they’re indexed, searchable, and considered in your debrief."
      />

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        className={clsx(
          'rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors mb-4',
          dragActive
            ? 'border-jarvis-400 bg-jarvis-50'
            : 'border-surface-border bg-surface-raised hover:border-jarvis-300',
        )}
      >
        <UploadCloud className="h-8 w-8 mx-auto text-ink-faint mb-3" />
        <p className="text-sm font-medium">Drop documents here</p>
        <p className="text-xs text-ink-muted mt-1 mb-4">
          PDF, DOCX, TXT, MD, CSV, JSON, HTML — up to 25 MB
        </p>
        <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()}>
          Browse files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          aria-label="Upload files"
          accept=".pdf,.docx,.txt,.md,.csv,.json,.html"
          className="sr-only"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* In-flight uploads */}
      {progress.length > 0 && (
        <ul className="space-y-1.5 mb-4">
          {progress.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm"
            >
              {p.status === 'error' ? (
                <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-jarvis-600 shrink-0" />
              )}
              <span className="flex-1 truncate">{p.name}</span>
              {p.status === 'queued' && <span className="text-xs text-ink-faint">Waiting…</span>}
              {p.status === 'uploading' && (
                <span className="text-xs text-ink-muted">Uploading…</span>
              )}
              {p.status === 'error' && (
                <>
                  <span className="text-xs text-red-600">{p.error ?? 'Upload failed'}</span>
                  <button
                    aria-label={`Dismiss ${p.name}`}
                    onClick={() => setProgress((list) => list.filter((e) => e.id !== p.id))}
                    className="text-ink-faint hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Library */}
      <Card>
        {files.isLoading && <LoadingPane label="Loading files…" />}
        {files.data && items.length === 0 && (
          <EmptyState
            icon={<FileText />}
            title="Drop a document to make it part of Jarvis’s world."
            description="Anything you upload is searchable and feeds your daily debrief."
          />
        )}
        {items.length > 0 && (
          <ul className="divide-y divide-surface-border">
            {items.map((file) => (
              <li key={file.id} className="flex items-center gap-3 px-4 py-3">
                <FileText className="h-4 w-4 text-ink-faint shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">{file.filename}</span>
                    <StatusBadge file={file} />
                    {file.textExtracted === 1 && <Badge tone="blue">Indexed for search</Badge>}
                  </div>
                  <p className="text-xs text-ink-muted mt-0.5">
                    {fileSize(file.sizeBytes)} · uploaded {timeAgo(file.createdAt)}
                  </p>
                </div>
                {file.status === 'ready' && (
                  <Button variant="ghost" size="sm" onClick={() => setViewing(file)}>
                    View text
                  </Button>
                )}
                <button
                  aria-label={`Delete ${file.filename}`}
                  title="Delete"
                  onClick={() => onDelete(file)}
                  className="p-1.5 rounded-lg text-ink-faint hover:text-red-600 hover:bg-surface-sunken transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ViewTextModal file={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
