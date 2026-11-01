/**
 * mai-charts 数据源
 *
 * 谱面数据（曲目目录 / simai 谱面文本 / 谱面分析）来自
 * https://cnb.cool/sulieripple/mai-charts（本项目 fork 后以静态数据形式发布到
 * 本仓库的 `public/data` 目录，或通过 VITE_MAI_CHARTS_DATA_BASE 指向其它镜像）。
 *
 * 音频与曲绘仍复用 lxns 的公开资源（assets2.lxns.net / assets.lxns.net）。
 */
import type { LxnsSong, LxnsSongListResponse } from '../lxns/types';

const configuredBase = import.meta.env.VITE_MAI_CHARTS_DATA_BASE as string | undefined;

/** 数据根地址：默认取当前站点同源的 `data/`（构建时由 BASE_URL 决定） */
export const MAI_CHARTS_DATA_BASE = (
  configuredBase ?? `${import.meta.env.BASE_URL}data`
).replace(/\/+$/, '');

export function maiChartsDataUrl(path: string): string {
  return `${MAI_CHARTS_DATA_BASE}/${path.replace(/^\/+/, '')}`;
}

export interface CatalogBundle {
  songs: LxnsSong[];
  aliases: Map<number, string[]>;
  versionTitlesByCode: Map<number, string>;
}

interface AliasFile {
  aliases: { song_id: number; aliases: string[] }[];
}

let catalogPromise: Promise<CatalogBundle> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * 加载曲目目录 + 别名 + 版本名映射（带缓存，重复调用不会重复请求）。
 * 目录来源：mai-charts `data/music_data.json` 生成的静态快照。
 */
export function loadCatalog(): Promise<CatalogBundle> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const [songJson, aliasJson] = await Promise.all([
        fetchJson<LxnsSongListResponse>(maiChartsDataUrl('catalog.json')),
        fetchJson<AliasFile>(maiChartsDataUrl('aliases.json')).catch(() => ({ aliases: [] })),
      ]);

      const aliases = new Map<number, string[]>();
      for (const entry of aliasJson.aliases ?? []) {
        aliases.set(entry.song_id, entry.aliases);
      }

      const versionTitlesByCode = new Map<number, string>();
      for (const v of songJson.versions ?? []) {
        versionTitlesByCode.set(v.version, v.title);
      }

      return {
        songs: songJson.songs ?? [],
        aliases,
        versionTitlesByCode,
      };
    })();
  }
  return catalogPromise;
}

const SIMAI_CACHE_MAX = 32;
const simaiCache = new Map<number, string>();

/**
 * 读取某个 chartFileId（标准谱=歌曲 id，DX=歌曲 id+10000）对应的 simai 文本。
 *
 * 注意：这里返回的是 mai-charts `.adx` 包内完整的 `maidata.txt`（包含全部难度，
 * `&inote_2` ~ `&inote_6`），由 ChartParser 按难度选择对应段落。
 */
export async function fetchSimaiText(chartFileId: number): Promise<string | null> {
  const cached = simaiCache.get(chartFileId);
  if (cached !== undefined) return cached;

  try {
    const res = await fetch(maiChartsDataUrl(`simai/${chartFileId}.txt`), { cache: 'force-cache' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;

    if (simaiCache.size >= SIMAI_CACHE_MAX) {
      const oldest = simaiCache.keys().next().value;
      if (oldest !== undefined) simaiCache.delete(oldest);
    }
    simaiCache.set(chartFileId, text);
    return text;
  } catch {
    return null;
  }
}

export interface RadarAxis {
  kind?: string;
  label: string;
  score: number;
}

export interface EvaluationAxis {
  kind?: string;
  label: string;
  score: number;
}

export interface ChartPattern {
  id?: string;
  kind?: string;
  label: string;
  measure?: number;
  beat?: number;
  endBeat?: number;
  /** 强度（用于区分爆发/一笔画等特征的显著程度） */
  strength?: number;
  details?: string;
}

export interface DifficultyClassification {
  tag?: string;
  label?: string;
  color?: string;
  estimatedLevel?: number;
  fittedLevel?: number;
  actualLevel?: number;
  actualLevelLabel?: string;
  deviation?: number;
  fittedDeviation?: number;
  hostility?: number | null;
}

export interface ChartConfigAnalysis {
  totalNotes?: number;
  playableNotes?: number;
  tapCount?: number;
  holdCount?: number;
  slideCount?: number;
  touchCount?: number;
  breakCount?: number;
  bpmChanges?: number;
  divisorChanges?: number;
  maxBpm?: number;
  minBpm?: number;
  durationSeconds?: number;
  averageNps?: number;
  peakNps?: number;
  handTravelRate?: number;
  handJumpRate?: number;
  steadyStreamShare?: number;
  touchChordRate?: number;
  patterns?: ChartPattern[];
  radarAxes?: RadarAxis[];
  evaluationAxes?: EvaluationAxis[];
  difficultyTag?: DifficultyClassification;
  noteTypeShare?: { label: string; value: number; color?: string }[];
}

/** AWMC chart-preview API `/api/v1/charts/:chartKey` 的谱面分析快照 */
export interface ChartAnalysis {
  chartKey: string;
  songId: number;
  title: string;
  artist: string;
  kind: string;
  difficulty: number;
  levelLabel?: string;
  chartFileId?: number;
  views?: number;
  ratingAverage?: number;
  ratingCount?: number;
  commentCount?: number;
  correctionCount?: number;
  configAnalysis?: ChartConfigAnalysis | null;
  /** 同步脚本写入的更新时间 */
  syncedAt?: string;
}

const ANALYSIS_CACHE_MAX = 16;
const analysisCache = new Map<string, ChartAnalysis | null>();

function analysisKey(songId: number, kind: string, difficulty: number): string {
  return `${songId}_${kind}_${difficulty}`;
}

/** 按谱面读取图表分析（不存在时返回 null，不抛错） */
export async function fetchChartAnalysis(
  songId: number,
  kind: string,
  difficulty: number
): Promise<ChartAnalysis | null> {
  const key = analysisKey(songId, kind, difficulty);
  if (analysisCache.has(key)) return analysisCache.get(key) ?? null;

  let value: ChartAnalysis | null = null;
  try {
    const res = await fetch(maiChartsDataUrl(`analysis/${key}.json`), { cache: 'force-cache' });
    if (res.ok) value = (await res.json()) as ChartAnalysis;
  } catch {
    value = null;
  }

  if (analysisCache.size >= ANALYSIS_CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  analysisCache.set(key, value);
  return value;
}
