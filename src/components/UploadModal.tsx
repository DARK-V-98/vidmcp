import { useState, type FormEvent, type DragEvent } from 'react';
import { FolderOpen, Link2, Upload, X } from 'lucide-react';
import type { MediaAsset, MediaRole } from '../types';

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploaded: (asset: MediaAsset) => void;
}

export function UploadModal({ open, onClose, onUploaded }: UploadModalProps) {
  const [mode, setMode] = useState<'upload' | 'source'>('upload');
  const [role, setRole] = useState<MediaRole>('reference');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sourceInput, setSourceInput] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const resetAndClose = () => {
    setError(null);
    setFile(null);
    setTitle('');
    setNotes('');
    setSourceInput('');
    onClose();
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) {
      setFile(dropped);
      if (!title) setTitle(dropped.name);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === 'upload') {
        if (!file) {
          throw new Error('Select a video or audio file first.');
        }
        const form = new FormData();
        form.append('file', file);
        form.append('role', role);
        form.append('title', title.trim() || file.name);
        if (notes.trim()) form.append('notes', notes.trim());

        const res = await fetch('/api/media/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed.');
        onUploaded(data.asset);
        resetAndClose();
      } else {
        if (!sourceInput.trim()) {
          throw new Error('Enter a local file path or media URL.');
        }
        const res = await fetch('/api/media/source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: sourceInput.trim(),
            role,
            title: title.trim() || undefined,
            notes: notes.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to register media.');
        onUploaded(data.asset);
        resetAndClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-[#121721] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Add Video or Audio Asset
          </h2>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Close modal"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#0b0e14] p-1">
            <button
              type="button"
              onClick={() => setMode('upload')}
              className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                mode === 'upload'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload File
            </button>
            <button
              type="button"
              onClick={() => setMode('source')}
              className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                mode === 'source'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Link2 className="h-3.5 w-3.5" />
              Local Path or URL
            </button>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Asset Role for AI Workflow
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ['reference', 'Reference'],
                  ['edited', 'Edited Cut'],
                  ['rendered', 'Rendered'],
                  ['audio', 'Audio'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRole(value)}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                    role === value
                      ? 'border-blue-500 bg-blue-600/15 text-blue-300'
                      : 'border-slate-800 bg-[#0b0e14] text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {mode === 'upload' ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`rounded-lg border border-dashed p-5 text-center transition-colors ${
                dragging
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-slate-700 bg-[#0b0e14]'
              }`}
            >
              <input
                id="media-file-input"
                type="file"
                accept="video/*,audio/*"
                className="hidden"
                onChange={(e) => {
                  const chosen = e.target.files?.[0] ?? null;
                  setFile(chosen);
                  if (chosen && !title) setTitle(chosen.name);
                }}
              />
              <label
                htmlFor="media-file-input"
                className="flex cursor-pointer flex-col items-center gap-2"
              >
                <FolderOpen className="h-6 w-6 text-slate-400" />
                <span className="text-sm font-medium text-slate-200">
                  {file ? file.name : 'Choose or drop MP4, MOV, WebM, MP3, WAV'}
                </span>
                <span className="text-xs text-slate-500">
                  Probed immediately with ffprobe for FPS, cuts, and audio peaks
                </span>
              </label>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Local File Path or Media URL
              </label>
              <input
                type="text"
                value={sourceInput}
                onChange={(e) => setSourceInput(e.target.value)}
                placeholder="/Users/you/renders/hero_cut.mp4 or https://..."
                className="w-full rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Local paths work when running CutCheck locally; HTTP/HTTPS URLs work both online and locally.
              </p>
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Clip Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Nike kinetic title reference"
              className="w-full rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">
              Notes for AI (Optional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Match the snappy 12-frame ease-out zoom at 0:01.4"
              className="w-full rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={resetAndClose}
              className="rounded-lg px-4 py-2 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {submitting ? 'Processing with ffprobe...' : 'Add to Workspace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
