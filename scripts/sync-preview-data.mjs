#!/usr/bin/env node
/**
 * 预览站数据同步（GitHub Actions / 本地运行）
 *
 * 做的事情：
 *  1. 调用 AWMC chart-preview API，增量拉取谱面列表与谱面分析（configAnalysis），
 *     写入 `public/data/analysis/*.json`，并维护指纹缓存 `data/preview-sync/chart-index.json`；
 *  2. 读取 mai-charts 仓库的 `data/music_data.json` / `data/music_alias.json`，
 *     从 `.adx` 包中提取 maidata.txt（simai）写入 `public/data/simai/{chartFileId}.txt`；
 *  3. 合并生成前端目录 `public/data/catalog.json` / `aliases.json` / `meta.json`，
 *     并把谱面索引快照发布为 `public/data/chart-index.json`（供 mai-charts 流水线读取）。
 *
 * 用法：
 *   node scripts/sync-preview-data.mjs                     # 增量（CI 默认）
 *   node scripts/sync-preview-data.mjs --full              # 强制全量刷新 API 详情
 *   node scripts/sync-preview-data.mjs --adx-dir ../mc-meta --force-adx
 *
 * 环境变量：
 *   CHART_PREVIEW_API_KEY   chart-preview API Key（必填）
 *   CHART_PREVIEW_API_BASE  默认 https://v.wmc.pub/api/v1
 *   MAI_CHARTS_REPO         默认 https://cnb.cool/sulieripple/mai-charts.git
 *   MAI_CHARTS_REF          默认 main
 *   CNB_TOKEN               CNB 访问令牌（公开仓库可省略；访问私有仓库时使用）
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChartPreviewApi } from './lib/api.mjs';
import { buildAdxEntries, buildCatalog, matchAdxToSongs, parseLevelLabel, parseMaidataMeta } from './lib/catalog.mjs';
import { LocalDirSource, RemoteRawSource } from './lib/maicharts-source.mjs';
import { extractMaidata } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { full: false, forceAdx: false, adxDir: null, outDir: null, cacheDir: null, workDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full') args.full = true;
    else if (arg === '--force-adx') args.forceAdx = true;
    else if (arg === '--adx-dir') args.adxDir = argv[++i];
    else if (arg === '--out') args.outDir = argv[++i];
    else if (arg === '--cache') args.cacheDir = argv[++i];
    else if (arg === '--work-dir') args.workDir = argv[++i];
    else if (arg === '--repo') process.env.MAI_CHARTS_REPO = argv[++i];
    else if (arg === '--ref') process.env.MAI_CHARTS_REF = argv[++i];
    else if (arg === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  args.outDir = path.resolve(ROOT, args.outDir ?? 'public/data');
  args.cacheDir = path.resolve(ROOT, args.cacheDir ?? 'data/preview-sync');
  args.workDir = path.resolve(ROOT, args.workDir ?? '.cache/mai-charts');
  return args;
}

function log(message) {
  console.log(`[sync] ${new Date().toISOString()} ${message}`);
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

function writeFileIfChanged(filePath, content) {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return false;
  } catch {
    // 文件不存在
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return true;
}

function chartFingerprint(item) {
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

function analysisFileName(item) {
  return `${item.songId}_${item.kind}_${item.difficulty}.json`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  fs.mkdirSync(args.outDir, { recursive: true });
  fs.mkdirSync(args.cacheDir, { recursive: true });
  const simaiDir = path.join(args.outDir, 'simai');
  const analysisDir = path.join(args.outDir, 'analysis');
  fs.mkdirSync(simaiDir, { recursive: true });
  fs.mkdirSync(analysisDir, { recursive: true });

  const cacheIndexPath = path.join(args.cacheDir, 'chart-index.json');
  const cacheMetaPath = path.join(args.cacheDir, 'maidata-meta.json');
  const oldIndex = readJson(cacheIndexPath, { charts: {} });
  const rawMaidataMeta = readJson(cacheMetaPath, {});
  // 兼容旧缓存：DX 谱面 chartFileId 曾被错误地再追加一次 10000
  const maidataMeta = {};
  for (const [key, value] of Object.entries(rawMaidataMeta)) {
    const normalized = String(key).length > 5 && String(key).endsWith('10000') ? String(key).slice(0, -5) : String(key);
    maidataMeta[normalized] = value;
  }
  /** @type {Record<string, { sha: string, title?: string, artist?: string, bpm?: number, levels: Record<string,string>, designers: Record<string,string> }>} */
  const metaByChartFileId = {};

  // ---------- 1. chart-preview API 增量同步 ----------
  const api = new ChartPreviewApi();
  log(`API: ${api.base}`);
  const firstPage = await api.listCharts({ page: 1, limit: 50 });
  const totalCharts = firstPage?.total ?? 0;
  log(`API 谱面总数：${totalCharts}`);

  const { items: apiCharts } = await api.listAllCharts(({ page, loaded, total }) => {
    if (page % 5 === 0 || loaded >= total) log(`  列表分页 ${page}，${loaded}/${total}`);
  });

  const nextIndex = { syncedAt: new Date().toISOString(), total: apiCharts.length, charts: {} };
  const toFetch = [];
  for (const item of apiCharts) {
    const fingerprint = chartFingerprint(item);
    const previous = oldIndex.charts?.[item.chartKey];
    const file = `analysis/${analysisFileName(item)}`;
    nextIndex.charts[item.chartKey] = {
      fingerprint,
      file,
      songId: item.songId,
      kind: item.kind,
      difficulty: item.difficulty,
      title: item.title,
      artist: item.artist,
      levelLabel: item.levelLabel ?? null,
      chartFileId: item.chartFileId ?? null,
      views: item.views ?? 0,
      ratingCount: item.ratingCount ?? 0,
      commentCount: item.commentCount ?? 0,
      correctionCount: item.correctionCount ?? 0,
      syncedAt: previous?.syncedAt ?? null,
    };
    const fileExists = fs.existsSync(path.join(args.outDir, file));
    if (args.full || !previous || previous.fingerprint !== fingerprint || !fileExists) {
      toFetch.push(item);
    }
  }
  log(`需要拉取谱面详情：${toFetch.length} / ${apiCharts.length}`);

  let fetched = 0;
  await api.pool(toFetch, async (item) => {
    const detail = await api.chartDetail(item.chartKey).catch((error) => {
      log(`  详情失败 ${item.chartKey}: ${error.message}`);
      return null;
    });
    if (!detail) return;
    const payload = {
      ...detail,
      syncedAt: new Date().toISOString(),
    };
    writeJson(path.join(args.outDir, `analysis/${analysisFileName(item)}`), payload);
    const entry = nextIndex.charts[item.chartKey];
    if (entry) entry.syncedAt = payload.syncedAt;
    fetched += 1;
    if (fetched % 50 === 0) log(`  详情 ${fetched}/${toFetch.length}`);
  }, 3);
  writeJson(cacheIndexPath, nextIndex);
  // 同时发布到站点静态目录，供 mai-charts（CNB）流水线按 HTTP 读取
  writeJson(path.join(args.outDir, 'chart-index.json'), nextIndex);
  log(`谱面详情完成：写入 ${fetched} 个`);

  // 聚合全部分析数据为单个 gzip 文件（CNB 流水线一次请求即可拿到全部详情）
  {
    const aggregated = { syncedAt: new Date().toISOString(), charts: {} };
    for (const [chartKey, entry] of Object.entries(nextIndex.charts)) {
      const detail = readJson(path.join(args.outDir, entry.file), null);
      if (detail) aggregated.charts[chartKey] = detail;
    }
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(aggregated)), { level: 9 });
    fs.writeFileSync(path.join(args.outDir, 'chart-analysis.json.gz'), payload);
    log(`聚合分析数据：${Object.keys(aggregated.charts).length} 个谱面，gzip ${(payload.length / 1024 / 1024).toFixed(1)}MB`);

    // 清理已从 API 列表中移除的谱面分析文件
    const validFiles = new Set(Object.values(nextIndex.charts).map((entry) => path.basename(entry.file)));
    const analysisDir = path.join(args.outDir, 'analysis');
    let removed = 0;
    for (const name of fs.readdirSync(analysisDir)) {
      if (!validFiles.has(name)) {
        fs.rmSync(path.join(analysisDir, name), { force: true });
        removed += 1;
      }
    }
    if (removed > 0) log(`清理失效分析文件：${removed} 个`);
  }

  // ---------- 2. mai-charts：.adx → simai ----------
  /** @type {{ listAdx: () => Promise<{path: string, sha: string, size: number}[]>, readBlob?: (sha: string) => Promise<Buffer>, readBlobByPath?: (p: string) => Promise<Buffer>, readTextFile: (p: string) => Promise<string|null>, headSha?: () => Promise<string> } } */
  let source;
  if (args.adxDir) {
    log(`mai-charts 数据源：本地目录 ${args.adxDir}`);
    source = new LocalDirSource(path.resolve(ROOT, args.adxDir));
  } else {
    source = new RemoteRawSource({
      workDir: args.workDir,
      ref: process.env.MAI_CHARTS_REF ?? 'main',
      repo: process.env.MAI_CHARTS_REPO,
      token: process.env.CNB_TOKEN,
    });
    log(`mai-charts 数据源：${source.repoSlug}@${source.ref}（tree partial clone + CNB raw 按需下载 .adx）`);
    await source.ensureClone();
  }

  const musicDataText = await source.readTextFile('data/music_data.json');
  if (!musicDataText) throw new Error('mai-charts 仓库缺少 data/music_data.json');
  // 宴会場（id>=100000）暂不纳入预览目录：其 chartFileId / 音频资源规则不同
  const musicData = JSON.parse(musicDataText).filter((song) => Number(song.id) < 100000);
  const aliasText = (await source.readTextFile('data/music_alias.json')) ?? '[]';
  const aliasList = JSON.parse(aliasText);
  log(`music_data 曲目条目：${musicData.length}，别名条目：${aliasList.length}`);

  const adxList = await source.listAdx();
  log(`.adx 包数量：${adxList.length}`);

  const adxEntries = buildAdxEntries(adxList);
  const matching = matchAdxToSongs(musicData, adxEntries);
  log(
    `曲目匹配：成功 ${matching.songMatches.length}，未匹配曲目 ${matching.unmatchedSongs.length}，未使用 .adx ${matching.unmatchedAdx.length}`
  );

  // 只处理匹配成功的曲目：提取/刷新 simai
  const tasks = matching.songMatches.map((match) => {
    const kind = match.type === 'DX' ? 'dx' : 'standard';
    // music_data 的 DX 记录 id 已经包含 +10000，因此这里直接使用其 id 作为 chartFileId
    const chartFileId = Number(match.songId);
    return { match, kind, chartFileId, adx: adxEntries.find((e) => e.path === match.adx) };
  });

  let extracted = 0;
  let reused = 0;
  const concurrency = args.adxDir ? 8 : 4;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) return;
        const task = tasks[index];
        const { chartFileId, adx } = task;
        const cached = maidataMeta[chartFileId];
        const simaiPath = path.join(simaiDir, `${chartFileId}.txt`);
        const needExtract = args.forceAdx || !cached || cached.sha !== adx.sha || !fs.existsSync(simaiPath);

        let text;
        if (needExtract) {
          try {
            const buffer = source.readBlobByPath
              ? await source.readBlobByPath(adx.path)
              : await source.readBlob(adx.sha);
            text = extractMaidata(buffer);
          } catch (error) {
            log(`  adx 解析失败 ${adx.path}: ${error.message}`);
            continue;
          }
          writeFileIfChanged(simaiPath, text);
          const meta = parseMaidataMeta(text);
          maidataMeta[chartFileId] = {
            sha: adx.sha,
            title: meta.title,
            artist: meta.artist,
            bpm: meta.bpm,
            levels: meta.levels,
            designers: meta.designers,
          };
          extracted += 1;
          if (extracted % 100 === 0) log(`  已提取 ${extracted} 个 adx`);
        } else {
          reused += 1;
        }
        metaByChartFileId[chartFileId] = maidataMeta[chartFileId];
      }
    })
  );
  log(`simai 提取：新增/更新 ${extracted}，复用 ${reused}`);
  writeJson(cacheMetaPath, maidataMeta);

  // 清理已不在目录中的 simai（曲目下架）
  const validChartFileIds = new Set(tasks.map((t) => Number(t.chartFileId)));
  let removedSimai = 0;
  for (const name of fs.readdirSync(simaiDir)) {
    if (!name.endsWith('.txt')) continue;
    const id = Number(name.slice(0, -4));
    if (!validChartFileIds.has(id)) {
      fs.rmSync(path.join(simaiDir, name));
      removedSimai += 1;
    }
  }
  if (removedSimai > 0) log(`清理失效 simai：${removedSimai} 个`);

  // ---------- 3. 生成前端目录 ----------
  /** @type {Map<string, string>} */
  const apiLevelByChartKey = new Map();
  for (const [chartKey, entry] of Object.entries(nextIndex.charts)) {
    const level = parseLevelLabel(entry.levelLabel);
    if (level) apiLevelByChartKey.set(chartKey, level);
  }

  const { catalog, aliases } = buildCatalog({
    musicData,
    aliasList,
    matching,
    maidataMetaByChartFileId: new Map(Object.entries(metaByChartFileId).map(([k, v]) => [Number(k), v])),
    apiLevelByChartKey,
  });

  writeJson(path.join(args.outDir, 'catalog.json'), catalog);
  writeJson(path.join(args.outDir, 'aliases.json'), aliases);

  const analysisCount = fs.readdirSync(analysisDir).filter((name) => name.endsWith('.json')).length;
  const simaiCount = fs.readdirSync(simaiDir).filter((name) => name.endsWith('.txt')).length;
  writeJson(path.join(args.outDir, 'meta.json'), {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    sources: {
      chartData: 'mai-charts (https://cnb.cool/sulieripple/mai-charts)',
      chartPreviewApi: api.base,
      audioAndJacket: 'lxns assets',
    },
    counts: {
      songs: catalog.songs.length,
      simai: simaiCount,
      analysis: analysisCount,
      apiCharts: nextIndex.total,
      adxPackages: adxList.length,
      matchedCharts: matching.songMatches.length,
      unmatchedSongs: matching.unmatchedSongs.length,
      unmatchedAdx: matching.unmatchedAdx.length,
    },
    unmatchedSongs: matching.unmatchedSongs.slice(0, 200),
    unmatchedAdx: matching.unmatchedAdx.slice(0, 200),
  });

  log(
    `完成：曲目 ${catalog.songs.length}，simai ${simaiCount}，分析 ${analysisCount}，API 请求 ${api.requestCount} 次，耗时 ${(
      (Date.now() - startedAt) / 1000
    ).toFixed(1)}s`
  );
}

main().catch((error) => {
  console.error('[sync] 同步失败：', error);
  process.exit(1);
});
