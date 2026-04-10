/** 与 assets2.lxns.net 上 simai 文件命名一致：标准谱用曲目 id，DX 谱用 id+10000（id&lt;100000），宴会场等用原 id。 */
export type ChartKind = 'standard' | 'dx' | 'utage';

export function chartFileIdForSong(songId: number, kind: ChartKind): number {
  if (kind === 'utage') return songId;
  if (kind === 'dx' && songId < 100000) return songId + 10000;
  return songId;
}

export function musicAssetIdFromChartFileId(chartFileId: number): number {
  return chartFileId % 10000;
}

/** 与 chartFileId % 10000 一致：同曲目 ID 下标准/DX/难度切换共用同一音频资源 */
export function musicMp3UrlForChartFileId(chartFileId: number): string {
  const assetId = musicAssetIdFromChartFileId(chartFileId);
  return `https://assets2.lxns.net/maimai/music/${assetId}.mp3`;
}

/** @deprecated 请优先使用 musicMp3UrlForChartFileId(chartFileId)，以便与谱面 id 规则一致 */
export function musicMp3UrlForLxnsSongId(songId: number): string {
  return musicMp3UrlForChartFileId(songId);
}

const SIMAI_CACHE_MAX = 64;
const simaiTextByChartFileId = new Map<number, string>();

export async function fetchSimaiText(chartFileId: number): Promise<string | null> {
  const cached = simaiTextByChartFileId.get(chartFileId);
  if (cached !== undefined) return cached;

  try {
    const response = await fetch(`https://assets2.lxns.net/maimai/chart/${chartFileId}.txt`);
    if (!response.ok) return null;
    const text = await response.text();
    if (simaiTextByChartFileId.size >= SIMAI_CACHE_MAX) {
      const oldest = simaiTextByChartFileId.keys().next().value;
      if (oldest !== undefined) simaiTextByChartFileId.delete(oldest);
    }
    simaiTextByChartFileId.set(chartFileId, text);
    return text;
  } catch {
    return null;
  }
}
