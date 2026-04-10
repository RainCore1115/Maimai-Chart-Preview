import type { ChartDifficulty } from './chart/types';
import type { ChartKind } from './lxns/chartResolve';

export const PREVIEW_URL = {
  song: 'song',
  kind: 'kind',
  diff: 'diff',
} as const;

export function parsePreviewUrlParams(searchParams: URLSearchParams): {
  songId: number | null;
  kind: ChartKind | null;
  diff: ChartDifficulty | null;
} {
  const rawSong = searchParams.get(PREVIEW_URL.song);
  const songId =
    rawSong != null && /^\d+$/.test(rawSong) ? parseInt(rawSong, 10) : null;

  const kindRaw = searchParams.get(PREVIEW_URL.kind);
  const kind: ChartKind | null =
    kindRaw === 'standard' || kindRaw === 'dx' || kindRaw === 'utage' ? kindRaw : null;

  const rawDiff = searchParams.get(PREVIEW_URL.diff);
  const d = rawDiff != null ? parseInt(rawDiff, 10) : NaN;
  const diff: ChartDifficulty | null =
    Number.isInteger(d) && d >= 1 && d <= 6 ? (d as ChartDifficulty) : null;

  return { songId, kind, diff };
}

export function buildPreviewUrlParams(args: {
  songId: number | null;
  kind: ChartKind | null;
  diff: ChartDifficulty | null;
}): URLSearchParams {
  const p = new URLSearchParams();
  if (args.songId != null) p.set(PREVIEW_URL.song, String(args.songId));
  if (args.kind != null && args.diff != null) {
    p.set(PREVIEW_URL.kind, args.kind);
    p.set(PREVIEW_URL.diff, String(args.diff));
  }
  return p;
}
