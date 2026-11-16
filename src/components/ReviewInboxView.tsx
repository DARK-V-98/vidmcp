import { useRef, useState } from 'react';
import { Check, Inbox, MessageSquarePlus, RotateCcw } from 'lucide-react';
import type { MediaAsset, ReviewRequest } from '../types';
import { formatTimecode, roleShortLabel } from '../utils/format';

interface ReviewInboxViewProps {
  reviews: ReviewRequest[];
  assets: MediaAsset[];
  onRefresh: () => void;
}

export function ReviewInboxView({ reviews, assets, onRefresh }: ReviewInboxViewProps) {
  const [selectedId, setSelectedId] = useState<string>(reviews[0]?.id ?? '');
  const [noteInput, setNoteInput] = useState('');
  const [markerInput, setMarkerInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const playerRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const activeReview = reviews.find((r) => r.id === selectedId) ?? reviews[0];
  const targetAsset = activeReview
    ? assets.find((a) => a.id === activeReview.mediaId)
    : undefined;
  const referenceAsset = activeReview?.referenceMediaId
    ? assets.find((a) => a.id === activeReview.referenceMediaId)
    : undefined;

  const handlePinMarker = async () => {
    if (!targetAsset || !markerInput.trim()) return;
    const t = playerRef.current?.currentTime ?? 0;
    await fetch(`/api/media/${targetAsset.id}/markers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestampSec: t,
        label: markerInput.trim(),
        author: 'human',
      }),
    });
    setMarkerInput('');
    onRefresh();
  };

  const handleResolve = async (status: 'approved' | 'changes_requested') => {
    if (!activeReview) return;
    setSubmitting(true);
    try {
      await fetch(`/api/reviews/${activeReview.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          reviewerNote:
            noteInput.trim() ||
            (status === 'approved' ? 'Approved in CutCheck QA.' : 'Changes requested.'),
        }),
      });
      setNoteInput('');
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  };

  if (reviews.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#121721] p-10 text-center">
        <Inbox className="mx-auto h-8 w-8 text-slate-500" />
        <h2 className="mt-3 font-display text-base font-semibold text-slate-100">
          Human QA Review Inbox is Empty
        </h2>
        <p className="mx-auto mt-1.5 max-w-lg text-sm text-slate-400">
          When Claude calls <code className="font-mono text-slate-200">request_human_review</code> via MCP (or when you click Queue Review on any clip), the video or audio appears here for you to watch, listen, and approve.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-5">
        <h1 className="font-display text-xl font-semibold text-slate-100">
          Human-in-the-Loop QA Review Inbox
        </h1>
        <p className="mt-0.5 text-sm text-slate-400">
          Watch rendered clips, listen to audio tracks, pin timestamped corrections, and return decisions to Claude.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Queue List */}
        <div className="space-y-2 lg:col-span-4">
          {reviews.map((rev) => {
            const asset = assets.find((a) => a.id === rev.mediaId);
            const isSelected = activeReview?.id === rev.id;
            const statusText =
              rev.status === 'approved'
                ? 'Approved'
                : rev.status === 'changes_requested'
                  ? 'Changes Requested'
                  : 'Pending Review';
            const statusColor =
              rev.status === 'approved'
                ? 'text-emerald-400'
                : rev.status === 'changes_requested'
                  ? 'text-amber-400'
                  : 'text-blue-400';

            return (
              <button
                key={rev.id}
                type="button"
                onClick={() => setSelectedId(rev.id)}
                className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
                  isSelected
                    ? 'border-blue-500 bg-[#161d2b]'
                    : 'border-slate-800 bg-[#121721] hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className={`font-medium ${statusColor}`}>{statusText}</span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {rev.requestedBy}
                  </span>
                </div>
                <div className="mt-1 truncate font-display text-sm font-semibold text-slate-100">
                  {asset?.title ?? rev.mediaId}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{rev.prompt}</p>
              </button>
            );
          })}
        </div>

        {/* Active Review Detail */}
        {activeReview && targetAsset && (
          <div className="space-y-5 lg:col-span-8">
            <div className="rounded-xl border border-slate-800 bg-[#121721] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  Review ID <span className="font-mono text-slate-200">{activeReview.id}</span>
                </span>
                <span>
                  Requested by {activeReview.requestedBy} ·{' '}
                  {roleShortLabel(targetAsset.role)}
                </span>
              </div>
              <h2 className="mt-1 font-display text-base font-semibold text-slate-100">
                {targetAsset.title}
              </h2>
              <p className="mt-1.5 text-sm text-slate-300">{activeReview.prompt}</p>
            </div>

            {/* Media Player(s) */}
            <div
              className={`grid gap-4 ${
                referenceAsset ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
              }`}
            >
              {referenceAsset && (
                <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1118]">
                  <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-400">
                    Reference: {referenceAsset.title}
                  </div>
                  <video
                    src={`/api/media/${referenceAsset.id}/stream`}
                    controls
                    playsInline
                    className="aspect-video w-full bg-black object-contain"
                  />
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0d1118]">
                <div className="border-b border-slate-800 px-3 py-2 text-xs font-medium text-slate-400">
                  Submission: {targetAsset.title}
                </div>
                {targetAsset.probe.hasVideo ? (
                  <video
                    ref={playerRef as React.RefObject<HTMLVideoElement>}
                    src={`/api/media/${targetAsset.id}/stream`}
                    controls
                    playsInline
                    className="aspect-video w-full bg-black object-contain"
                  />
                ) : (
                  <div className="p-6">
                    <audio
                      ref={playerRef as React.RefObject<HTMLAudioElement>}
                      src={`/api/media/${targetAsset.id}/stream`}
                      controls
                      className="w-full"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Quick timestamp marker */}
            <div className="rounded-xl border border-slate-800 bg-[#121721] p-4">
              <div className="flex flex-wrap gap-2">
                <input
                  type="text"
                  value={markerInput}
                  onChange={(e) => setMarkerInput(e.target.value)}
                  placeholder="Pin timestamp note at current player time..."
                  className="min-w-[220px] flex-1 rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handlePinMarker}
                  disabled={!markerInput.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-100 whitespace-nowrap shrink-0 hover:bg-slate-700 disabled:opacity-40"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  Pin Timestamp
                </button>
              </div>

              {targetAsset.markers.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {targetAsset.markers.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-2.5 text-xs text-slate-300"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (playerRef.current) {
                            playerRef.current.currentTime = m.timestampSec;
                          }
                        }}
                        className="rounded bg-[#0b0e14] px-2 py-0.5 font-mono text-[11px] text-blue-300 tabular-nums"
                      >
                        {formatTimecode(m.timestampSec)}
                      </button>
                      <span className="text-slate-500">
                        {m.author === 'ai' ? 'AI' : 'Human'}
                      </span>
                      <span>{m.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Decision Box */}
            <div className="rounded-xl border border-slate-800 bg-[#121721] p-4 space-y-3">
              <label className="block text-xs font-medium text-slate-300">
                Feedback Sent Back to Claude ({activeReview.status === 'pending' ? 'Pending' : 'Update Decision'})
              </label>
              <textarea
                rows={3}
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder={
                  activeReview.reviewerNote ||
                  'e.g. Motion easing looks crisp up to 0:02.1s, but the audio hit lands 3 frames late on the title reveal.'
                }
                className="w-full rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
              />
              {activeReview.reviewerNote && (
                <p className="text-xs text-slate-400">
                  Last saved decision note: <span className="text-slate-200">{activeReview.reviewerNote}</span>
                </p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleResolve('changes_requested')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/30 px-4 py-2 text-xs font-semibold text-amber-300 whitespace-nowrap shrink-0 transition-colors hover:bg-amber-950/60 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Request Changes
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => handleResolve('approved')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Check className="h-3.5 w-3.5" />
                  Approve Render
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
