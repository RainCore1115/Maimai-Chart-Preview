#!/usr/bin/env node
/**
 * mai-charts 增量数据更新（在 mai-charts 仓库根目录、CNB 流水线中运行）
 *
 * 数据来源：AWMC chart-preview API（https://wiki.awmc.team/dev/chart-preview-api）
 *  - 若提供了 CHART_PREVIEW_API_KEY（可通过 CNB「密钥仓库」导入），直接调用 API；
 *  - 否则读取预览站发布的 API 静态快照（按顺序尝试多个镜像，失败自动切换）：
 *      {base}/chart-index.json                     谱面列表 + 指纹
 *      {base}/chart-analysis.json.gz               全部谱面详情聚合（含 configAnalysis）
 *      {base}/analysis/*.json                      单个谱面详情（聚合文件不可用时回退）
 *      {base}/catalog.json                         .adx 提取出的最新等级/谱师
 *    也可以用 --preview-dir 指向本地已克隆的预览站仓库。
 *    镜像可通过 --preview-base 或环境变量 PREVIEW_DATA_BASE 覆盖（逗号分隔）。
 *
 * 更新内容：
 *  - data/chart_analysis/{谱面}.json + _index.json   每个谱面的完整分析（configAnalysis）
 *  - data/chart_preview_index.json                  chart-preview API 谱面索引快照
 *  - data/music_data.json                           已有曲目的等级 / 谱师 / BPM / 艺术家增量更新
 *  - data/music_chart.json                          已有曲目的难度等级标签同步
 *  - 可选 --add-new-songs：把 API 中新增曲目以最小字段补进 music_data.json
 *
 * 用法：node scripts/sync-maicharts.mjs [--preview-dir DIR | --preview-base URL] [--repo-root .] [--dry-run] [--add-new-songs]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { ChartPreviewApi } from './lib/api.mjs';
import { parseLevelLabel } from './lib/catalog.mjs';

function parseArgs(argv) {
  const args = {
    // 预览站静态数据镜像，按顺序尝试；默认 jsDelivr（国内相对稳定）+ GitHub Pages
    previewBase:
      process.env.PREVIEW_DATA_BASE ??
      [
        'https://cdn.jsdelivr.net/gh/RainCore1115/Maimai-Chart-Preview@main/public/data',
        'https://raincore1115.github.io/Maimai-Chart-Preview/data',
      ].join(','),
    previewDir: '',
    repoRoot: '.',
    dryRun: false,
    addNewSongs: false,
    apiKey: process.env.CHART_PREVIEW_API_KEY ?? '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preview-dir') args.previewDir = argv[++i];
    else if (arg === '--preview-base') args.previewBase = argv[++i];
    else if (arg === '--repo-root') args.repoRoot = argv[++i];
    else if (arg === '--api-key') args.apiKey = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--add-new-songs') args.addNewSongs = true;
  }
  return args;
}

function log(message) {
  console.log(`[maicharts-sync] ${new Date().toISOString()} ${message}`);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function analyzeFileName(chartKey) {
  return `${chartKey.replace(/:/g, '_')}.json`;
}

function fingerprintOf(item) {
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        item.title,
        item.artist,
        item.levelLabel,
        item.views,
        item.ratingAverage,
        item.ratingCount,
        item.commentCount,
        item.correctionCount,
      ])
    )
    .digest('hex')
    .slice(0, 16);
}

/** 带重试的 HTTP gzip JSON 读取（聚合快照） */
async function fetchGzipJson(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 带重试的 HTTP JSON 读取 */
async function fetchJsonUrl(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 预览站数据根地址列表 */
function previewRoots(previewBase) {
  return String(previewBase)
    .split(',')
    .map((base) => base.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** 依次尝试多个镜像，返回第一个可用结果 */
async function tryMirrors(bases, loader, label) {
  let lastError;
  for (const base of bases) {
    try {
      const result = await loader(base);
      if (result != null) return { base, result };
    } catch (error) {
      lastError = error;
      log(`  镜像不可用 ${base}（${label}）：${error.message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} 在所有镜像上都不可用`);
}

/** 加载谱面索引（本地仓库 或 预览站静态镜像），返回 { index, base } */
async function loadSnapshot(previewDir, previewBases) {
  if (previewDir) {
    const index = readJson(path.join(previewDir, 'data/preview-sync/chart-index.json'), null);
    if (!index?.charts) throw new Error(`本地预览站仓库缺少快照：${previewDir}`);
    return { index, base: '' };
  }
  const { base, result: index } = await tryMirrors(previewBases, (mirror) => fetchJsonUrl(`${mirror}/chart-index.json`), '谱面索引');
  if (!index?.charts) throw new Error(`镜像返回的谱面索引格式不正确：${base}/chart-index.json`);
  return { index, base };
}

/** 读取某个谱面的详情 JSON（本地仓库 或 预览站静态镜像） */
async function loadDetailFromSnapshot(previewDir, sourceBase, item) {
  const relative = item.file
    ? item.file.replace(/^data\/chart_analysis\//, '').replace(/^analysis\//, '')
    : `${item.songId}_${item.kind}_${item.difficulty}.json`;
  if (previewDir) {
    return readJson(path.join(previewDir, 'public/data/analysis', relative), null);
  }
  return fetchJsonUrl(`${sourceBase}/analysis/${relative}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repoRoot);
  const previewDir = args.previewDir ? path.resolve(args.previewDir) : '';

  const musicDataPath = path.join(repoRoot, 'data/music_data.json');
  const musicChartPath = path.join(repoRoot, 'data/music_chart.json');
  const previewIndexPath = path.join(repoRoot, 'data/chart_preview_index.json');
  const analysisDir = path.join(repoRoot, 'data/chart_analysis');
  const analysisIndexPath = path.join(analysisDir, '_index.json');

  const musicData = readJson(musicDataPath, null);
  if (!Array.isArray(musicData)) throw new Error(`无法读取 ${musicDataPath}`);
  const oldMusicData = structuredClone(musicData);
  const musicChart = readJson(musicChartPath, { charts: {}, diff_data: {} });
  const analysisIndex = readJson(analysisIndexPath, { charts: {} });

  // ---------- 1. 取得谱面列表 ----------
  let chartItems = [];
  /** @type {Map<string, any>} */
  const detailCache = new Map();
  let api = null;
  let sourceLabel = '';

  if (args.apiKey) {
    log('数据来源：直接调用 chart-preview API');
    api = new ChartPreviewApi({ apiKey: args.apiKey });
    const { items } = await api.listAllCharts();
    chartItems = items;
    sourceLabel = api.base;
  } else {
    const previewBases = previewRoots(args.previewBase);
    log(`数据来源：预览站 API 快照（镜像 ${previewBases.length} 个）`);
    const { index, base: sourceBase } = await loadSnapshot(previewDir, previewBases);
    sourceLabel = previewDir ? `${previewDir}/data/preview-sync/chart-index.json` : `${sourceBase}/chart-index.json`;
    log(`实际镜像：${sourceLabel}`);
    chartItems = Object.entries(index.charts).map(([chartKey, entry]) => ({ chartKey, ...entry }));
    if (!previewDir) {
      // 优先使用聚合快照（一次 HTTP 请求拿到全部谱面分析，避免上千次小请求）
      const { base: aggregateBase, result: aggregate } = await tryMirrors(
        [sourceBase, ...previewBases.filter((mirror) => mirror !== sourceBase)],
        (mirror) => fetchGzipJson(`${mirror}/chart-analysis.json.gz`),
        '聚合分析快照'
      ).catch((error) => {
        log(`聚合快照读取失败（将退回逐文件读取）：${error.message}`);
        return { base: sourceBase, result: null };
      });
      if (aggregate?.charts) {
        for (const [chartKey, detail] of Object.entries(aggregate.charts)) detailCache.set(chartKey, detail);
        log(`已加载聚合分析快照：${detailCache.size} 个谱面（${aggregateBase}/chart-analysis.json.gz）`);
      }
    }
  }
  log(`谱面条目：${chartItems.length}`);

  // ---------- 2. 谱面分析（C） ----------
  let copied = 0;
  let fetched = 0;
  const nextAnalysisIndex = { syncedAt: new Date().toISOString(), charts: {} };
  for (const item of chartItems) {
    const fingerprint = fingerprintOf(item);
    const fileName = analyzeFileName(item.chartKey);
    const targetPath = path.join(analysisDir, fileName);
    const previous = analysisIndex.charts?.[item.chartKey];
    nextAnalysisIndex.charts[item.chartKey] = { fingerprint, file: fileName, syncedAt: previous?.syncedAt ?? null };

    if (previous?.fingerprint === fingerprint && fs.existsSync(targetPath)) continue;

    let detail = null;
    if (api) {
      detail = await api.chartDetail(item.chartKey).catch(() => null);
      if (detail) fetched += 1;
    } else {
      detail = detailCache.get(item.chartKey) ?? (await loadDetailFromSnapshot(previewDir, args.previewBase, item));
      if (detail) copied += 1;
    }
    if (!detail) continue;

    const payload = { ...detail, syncedAt: new Date().toISOString() };
    if (!args.dryRun) writeJson(targetPath, payload);
    nextAnalysisIndex.charts[item.chartKey].syncedAt = payload.syncedAt;
    detailCache.set(item.chartKey, payload);
  }
  log(`谱面分析：新增/更新 ${copied + fetched}，复用 ${chartItems.length - copied - fetched}`);
  if (!args.dryRun) {
    writeJson(analysisIndexPath, nextAnalysisIndex);
    // ---------- 3. 谱面索引快照（B，独立文件，不破坏原有 schema） ----------
    writeJson(previewIndexPath, {
      syncedAt: new Date().toISOString(),
      source: sourceLabel,
      total: chartItems.length,
      charts: Object.fromEntries(
        chartItems.map((item) => [
          item.chartKey,
          {
            chartKey: item.chartKey,
            songId: item.songId,
            kind: item.kind,
            difficulty: item.difficulty,
            title: item.title,
            artist: item.artist,
            levelLabel: item.levelLabel ?? null,
            chartFileId: item.chartFileId ?? null,
            views: item.views ?? 0,
            ratingAverage: item.ratingAverage ?? 0,
            ratingCount: item.ratingCount ?? 0,
            commentCount: item.commentCount ?? 0,
            correctionCount: item.correctionCount ?? 0,
            file: `data/chart_analysis/${analyzeFileName(item.chartKey)}`,
          },
        ])
      ),
    });
  }

  // ---------- 4. 更新 music_data.json（仅已有曲目，避免破坏 adx 关联） ----------
  /** 键为 music_data 中的 `${id}:${type}`，类型即 SD / DX（DX 记录的 id = 落雪基础 id + 10000） */
  const byIdType = new Map(musicData.map((song) => [`${song.id}:${song.type}`, song]));
  /** 键为落雪基础 id（DX 记录会还原为 id-10000） */
  const byId = new Map();
  for (const song of musicData) {
    const numericId = Number(song.id);
    const baseId = Number.isFinite(numericId) && numericId >= 10000 ? String(numericId - 10000) : String(song.id);
    const list = byId.get(baseId) ?? [];
    list.push(song);
    byId.set(baseId, list);
  }

  let updatedLevels = 0;
  let typeMismatch = 0;
  let addedSongs = 0;

  for (const item of chartItems) {
    if (item.kind !== 'standard' && item.kind !== 'dx') continue;
    const kind = item.kind === 'dx' ? 'DX' : 'SD';
    const songId = String(item.songId);
    if (Number(songId) >= 100000) continue; // 宴会場暂不处理

    const difficultyIndex = Number(item.difficulty) - 2; // 2..6 → 0..4
    if (difficultyIndex < 0 || difficultyIndex > 4) continue;

    // music_data 中 DX 记录的 id 是「落雪基础 id + 10000」
    const mdId = kind === 'DX' ? String(Number(songId) + 10000) : songId;
    let song = byIdType.get(`${mdId}:${kind}`) ?? null;
    if (!song) {
      const sameSong = byId.get(songId) ?? [];
      if (sameSong.length > 0) {
        // 该曲目已有另一种类型的记录；默认不新增类型，避免与 adx 包不一致
        typeMismatch += 1;
        continue;
      }
      if (!args.addNewSongs) continue;
      song = {
        id: mdId,
        title: item.title || '',
        type: kind,
        ds: [0, 0, 0, 0, 0],
        level: ['', '', '', '', ''],
        cids: [0, 0, 0, 0, 0],
        charts: [],
        basic_info: {
          title: item.title || '',
          artist: item.artist || '',
          genre: '',
          bpm: 0,
          release_date: '',
          from: '',
          is_new: true,
        },
        _source: 'chart-preview-api',
      };
      musicData.push(song);
      byIdType.set(`${mdId}:${kind}`, song);
      const list = byId.get(songId) ?? [];
      list.push(song);
      byId.set(songId, list);
      addedSongs += 1;
    }

    const level = parseLevelLabel(item.levelLabel);
    if (!level) continue;
    if (!Array.isArray(song.level)) song.level = ['', '', '', '', ''];
    if (song.level[difficultyIndex] !== level) {
      song.level[difficultyIndex] = level;
      updatedLevels += 1;
    }
  }

  // 用 catalog.json（.adx 内 maidata 元信息）更新谱师 / BPM / 艺术家
  let updatedChartMeta = 0;
  const catalog = previewDir
    ? readJson(path.join(previewDir, 'public/data/catalog.json'), null)
    : await tryMirrors(previewRoots(args.previewBase), (mirror) => fetchJsonUrl(`${mirror}/catalog.json`), '曲目目录')
        .then(({ result }) => result)
        .catch(() => null);
  if (catalog?.songs) {
    let matchedCatalogRows = 0;
    for (const catalogSong of catalog.songs) {
      const targets = byId.get(String(catalogSong.id)) ?? [];
      if (targets.length === 0) continue;
      const rows = [
        ...(catalogSong.difficulties?.standard ?? []),
        ...(catalogSong.difficulties?.dx ?? []),
      ];
      for (const target of targets) {
        if (catalogSong.artist && !target.basic_info?.artist) {
          target.basic_info = target.basic_info ?? {};
          target.basic_info.artist = catalogSong.artist;
          updatedChartMeta += 1;
        }
        if (catalogSong.bpm && !target.basic_info?.bpm) {
          target.basic_info = target.basic_info ?? {};
          target.basic_info.bpm = catalogSong.bpm;
          updatedChartMeta += 1;
        }
      }
      for (const row of rows) {
        const kind = row.type === 'dx' ? 'DX' : 'SD';
        const mdId = kind === 'DX' ? String(Number(catalogSong.id) + 10000) : String(catalogSong.id);
        const target = byIdType.get(`${mdId}:${kind}`);
        if (!target) continue;
        const index = Number(row.difficulty);
        if (Number.isNaN(index) || index < 0 || index > 4) continue;
        if (!Array.isArray(target.charts)) target.charts = [];
        const chart = target.charts[index] ?? (target.charts[index] = { notes: [0, 0, 0, 0], charter: '' });
        if (row.note_designer && chart.charter !== row.note_designer) {
          chart.charter = row.note_designer;
          updatedChartMeta += 1;
        }
        if (!Array.isArray(chart.notes)) chart.notes = [0, 0, 0, 0];
        matchedCatalogRows += 1;
      }
    }
    log(`catalog 合并：${matchedCatalogRows} 个难度行`);
  }

  // ---------- 5. 更新 music_chart.json ----------
  const oldByKey = new Map(oldMusicData.map((song) => [`${song.id}:${song.type}`, song]));
  let addedChartKeys = 0;
  let relabeled = 0;
  for (const song of musicData) {
    const key = String(song.id);
    if (!musicChart.charts[key]) {
      musicChart.charts[key] = [];
      addedChartKeys += 1;
    }
    const oldSong = oldByKey.get(`${song.id}:${song.type}`);
    const entries = musicChart.charts[key];
    if (!Array.isArray(entries) || !Array.isArray(oldSong?.level) || !Array.isArray(song.level)) continue;
    for (let i = 0; i < 5; i += 1) {
      const oldLevel = oldSong.level[i];
      const newLevel = song.level[i];
      if (!oldLevel || !newLevel || oldLevel === newLevel) continue;
      const entry = entries.find((e) => e && e.diff === oldLevel && !e.__relabeled);
      if (entry) {
        entry.diff = newLevel;
        entry.__relabeled = true;
        relabeled += 1;
      }
    }
  }
  for (const entries of Object.values(musicChart.charts)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) if (entry && typeof entry === 'object') delete entry.__relabeled;
  }

  log(
    `music_data：等级 ${updatedLevels}，新增曲目 ${addedSongs}，类型冲突跳过 ${typeMismatch}，元信息 ${updatedChartMeta}；` +
      `music_chart：新增键 ${addedChartKeys}，等级标签 ${relabeled}`
  );

  if (args.dryRun) {
    log('--dry-run 模式，不写入文件');
    return;
  }

  writeJson(musicDataPath, musicData);
  writeJson(musicChartPath, musicChart);
  log('已写入 data/music_data.json / data/music_chart.json / data/chart_analysis/');
}

main().catch((error) => {
  console.error('[maicharts-sync] 同步失败：', error);
  process.exit(1);
});
