/**
 * 以「夸克分享盘 adx 谱面包」为谱面数据源，增量补全预览站目录。
 *
 * 数据源：https://pan.quark.cn/s/485e4886edd4?pwd=chXQ （29 个版本包，约 17GB）
 * 解析：netdisk-fast-download（本地/远端 `NFD_BASE`）或夸克官方 API（`QUARK_COOKIE`）。
 *
 * 关键点：不下载 1GB+ 的整包，而是用 HTTP Range 远程读取 ZIP 中央目录，只取每个曲目的
 * `maidata.txt`（几十 KB），因此全部 29 个版本包跑一轮只要 1~2 分钟、几 MB 流量。
 *
 * 产出：
 *  - `public/data/simai/{chartFileId}.txt`：新增曲目的谱面（目录已有曲目不覆盖，除非 --refresh-all）
 *  - `data/adx-share/catalog-extra.json`：目录补丁（新增版本 + 新增曲目），由
 *    `scripts/sync-preview-data.mjs` 合并进 catalog.json
 *  - `data/adx-share/report.json`：同步报告（匹配统计 / 未收录列表）
 *  - `public/data/download-packs.json`：谱面下载站使用的版本包清单
 *
 * 用法：
 *   NFD_BASE=http://127.0.0.1:6400 node scripts/sync-adx-quark.mjs
 *   QUARK_COOKIE='...' node scripts/sync-adx-quark.mjs --refresh-lxns
 *   node scripts/sync-adx-quark.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMaidataMeta, normalizeTitle } from './lib/catalog.mjs';
import { buildBotSupplement } from './lib/bot-supplement.mjs';
import { DEFAULT_SHARE_PWD, DEFAULT_SHARE_URL, QuarkShareSource } from './lib/quark-share.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public/data');
const DATA_DIR = path.join(ROOT, 'data/adx-share');
const LXNS_SONG_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list';

function log(message) {
  console.log(message);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    refreshAll: false,
    refreshLxns: false,
    maxPacks: 0,
    catalogPath: null,
    shareUrl: process.env.QUARK_SHARE_URL ?? DEFAULT_SHARE_URL,
    sharePwd: process.env.QUARK_SHARE_PWD ?? DEFAULT_SHARE_PWD,
    resolverBase: process.env.NFD_BASE ?? '',
    cookie: process.env.QUARK_COOKIE ?? '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--refresh-all') args.refreshAll = true;
    else if (arg === '--refresh-lxns') args.refreshLxns = true;
    else if (arg === '--max-packs') args.maxPacks = Number(argv[++i]) || 0;
    else if (arg === '--catalog') args.catalogPath = argv[++i];
    else if (arg === '--share-url') args.shareUrl = argv[++i];
    else if (arg === '--share-pwd') args.sharePwd = argv[++i];
    else if (arg === '--resolver') args.resolverBase = argv[++i];
    else if (arg === '--cookie') args.cookie = argv[++i];
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 1)}\n`);
}

function writeFileIfChanged(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) return false;
  fs.writeFileSync(filePath, content);
  return true;
}

/** 版本包序号 → 官方版本标题 */
const PACK_VERSION_TITLES = {
  0: 'maimai でらっくす 宴会场',
  1: 'maimai',
  2: 'maimai PLUS',
  3: 'maimai GreeN',
  4: 'maimai GreeN PLUS',
  5: 'maimai ORANGE',
  6: 'maimai ORANGE PLUS',
  7: 'maimai PiNK',
  8: 'maimai PiNK PLUS',
  9: 'maimai MURASAKi',
  10: 'maimai MURASAKi PLUS',
  11: 'maimai MiLK',
  12: 'maimai MiLK PLUS',
  13: 'maimai FiNALE',
  14: 'maimai でらっくす',
  15: 'maimai でらっくす PLUS',
  16: 'maimai でらっくす Splash',
  17: 'maimai でらっくす Splash PLUS',
  18: 'maimai でらっくす UNiVERSE',
  19: 'maimai でらっくす UNiVERSE PLUS',
  20: 'maimai でらっくす FESTiVAL',
  21: 'maimai でらっくす FESTiVAL PLUS',
  22: 'maimai でらっくす BUDDiES',
  23: 'maimai でらっくす BUDDiES PLUS',
  24: 'maimai でらっくす PRiSM',
  25: 'maimai でらっくす PRiSM PLUS',
  26: 'maimai でらっくす CiRCLE',
  27: 'maimai でらっくす CiRCLE PLUS',
  28: 'maimai でらっくす MAGiCAL',
};

/** 解析版本包文件名：`25. PRiSM PLUS.zip` → { num, name } */
function parsePackName(fileName) {
  const matched = /^(\d+)\.\s*(.+)\.zip$/i.exec(fileName.trim());
  if (!matched) return null;
  const num = Number(matched[1]);
  const name = matched[2].trim();
  return { num, name, versionTitle: PACK_VERSION_TITLES[num] ?? `maimai でらっくす ${name}` };
}

/** 标题候选（目录/字段里常见的后缀、前缀变化） */
function titleKeys(...values) {
  const keys = new Set();
  for (const value of values) {
    if (!value) continue;
    const raw = String(value).trim();
    const variants = [
      raw,
      raw.replace(/\s*\[DX\]\s*$/i, ''),
      raw.replace(/^\[[^\]]*\]\s*/, ''),
      raw.replace(/\s*\[(?:1P|2P|1p|2p)\]\s*/g, ' '),
      raw.replace(/\s*\[(EASY|HARD|NORMAL|EXPERT|MASTER|RE:MASTER)\]\s*$/i, ''),
      raw.replace(/\s*-\s*Copy\s*$/i, ''),
    ];
    for (const variant of variants) {
      const key = normalizeTitle(variant);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** 从 maidata 原始文本判断是否宴谱 */
function isUtageMaidata(text) {
  return /&(?:inote|lv|des)_7\s*=/i.test(text);
}

function levelKeyOf(difficulty) {
  return difficulty + 2;
}

/** 比较 maidata 等级与落雪等级，判断谱面属于 standard 还是 dx */
function guessKind(meta, folder, lxnsSong) {
  const folderText = `${folder}`.toLowerCase();
  if (/\[dx\]/.test(folderText)) return 'dx';
  const standard = lxnsSong.difficulties?.standard ?? [];
  const dx = lxnsSong.difficulties?.dx ?? [];
  if (standard.length && !dx.length) return 'standard';
  if (dx.length && !standard.length) return 'dx';
  const score = (rows) => {
    let hit = 0;
    let total = 0;
    for (const row of rows) {
      const expected = String(row.level ?? '').trim();
      const actual = String(meta.levels?.[levelKeyOf(row.difficulty)] ?? '').trim();
      if (!expected) continue;
      total += 1;
      if (expected === actual) hit += 1;
    }
    return total ? hit / total : 0;
  };
  return score(dx) > score(standard) ? 'dx' : 'standard';
}

/** 构造 catalog 曲目条目 */
function buildSongEntry(lxnsSong, kind, meta, versionId, chartText) {
  const rows = lxnsSong.difficulties?.[kind] ?? [];
  const difficulties = { standard: [], dx: [], utage: [] };
  for (const row of rows) {
    const levelIndex = levelKeyOf(row.difficulty);
    const designer = meta.designers?.[levelIndex];
    difficulties[kind].push({
      type: kind,
      difficulty: row.difficulty,
      level: String(row.level ?? meta.levels?.[levelIndex] ?? ''),
      level_value: Number(row.level_value) || 0,
      note_designer: designer || row.note_designer || '',
      version: versionId,
    });
  }
  const title = lxnsSong.title;
  return {
    id: Number(lxnsSong.id),
    title,
    artist: lxnsSong.artist ?? '',
    genre: lxnsSong.genre ?? 'maimai',
    bpm: Number(meta.bpm) || Number(lxnsSong.bpm) || 0,
    version: versionId,
    difficulties,
    map: null,
    rights: null,
    locked: false,
    disabled: false,
    _adxChartText: chartText,
  };
}

async function fetchJson(url, { timeoutMs = 60_000, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; maimai-chart-preview)', accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** 拉取落雪曲库（带缓存） */
async function loadLxnsSongs({ refresh }) {
  const cachePath = path.join(DATA_DIR, 'lxns-songs.json');
  const cached = readJson(cachePath, null);
  const fresh =
    cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < 6 * 60 * 60 * 1000 && cached?.songs?.length > 1000;
  if (fresh && !refresh) {
    log(`落雪曲库：使用缓存（${cached.songs.length} 首，${cached.fetchedAt}）`);
    return cached.songs;
  }
  log('落雪曲库：拉取中…');
  const data = await fetchJson(LXNS_SONG_LIST_URL);
  const songs = data.songs ?? [];
  writeJson(cachePath, { fetchedAt: new Date().toISOString(), count: songs.length, songs });
  log(`落雪曲库：${songs.length} 首，已缓存`);
  return songs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const catalogPath = args.catalogPath ? path.resolve(ROOT, args.catalogPath) : path.join(PUBLIC_DIR, 'catalog.json');
  const catalog = readJson(catalogPath, null);
  if (!catalog?.songs?.length) throw new Error(`缺少现有目录：${catalogPath}`);
  log(`现有目录：曲目 ${catalog.songs.length}，版本 ${catalog.versions.length}`);

  // 增量：保留历史补丁（catalog 里可能已并入这些曲目，重复运行不能把它们清掉）
  const prevExtra = readJson(path.join(DATA_DIR, 'catalog-extra.json'), { versions: [], songs: [] });
  const prevExtraSongs = new Map((prevExtra.songs ?? []).map((song) => [Number(song.id), song]));
  const prevExtraVersions = new Map((prevExtra.versions ?? []).map((version) => [Number(version.id), version]));
  const baselineIds = new Set(catalog.songs.map((song) => Number(song.id)));

  const lxnsSongs = await loadLxnsSongs({ refresh: args.refreshLxns });
  const lxnsNormalByTitle = new Map();
  const lxnsUtageByTitle = new Map();
  for (const song of lxnsSongs) {
    const isUtage = song.genre === '宴会場';
    const index = isUtage ? lxnsUtageByTitle : lxnsNormalByTitle;
    const key = normalizeTitle(song.title);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(song);
  }
  const catalogByTitle = new Map();
  for (const song of catalog.songs) {
    const key = normalizeTitle(song.title);
    if (!key) continue;
    if (!catalogByTitle.has(key)) catalogByTitle.set(key, []);
    catalogByTitle.get(key).push(song);
  }

  const source = new QuarkShareSource({
    mode: args.resolverBase ? 'resolver' : 'direct',
    resolverBase: args.resolverBase,
    shareUrl: args.shareUrl,
    sharePwd: args.sharePwd,
    cookie: args.cookie,
    logger: log,
  });
  log(`分享盘：${args.shareUrl}（模式：${source.mode}）`);
  const files = await source.listFiles();
  log(`版本包：${files.length} 个`);

  /** @type {{ num: number, name: string, versionTitle: string, size: number, fid: string }[]} */
  const packs = [];
  for (const file of files) {
    const parsed = parsePackName(file.name);
    if (!parsed) {
      log(`  跳过非版本包：${file.name}`);
      continue;
    }
    packs.push({ ...parsed, size: file.size, fid: file.fid, fileName: file.name });
  }
  packs.sort((a, b) => a.num - b.num);

  // 版本条目：复用现有版本 / 按需追加新版本（只有确实新增曲目时才建版本）
  const versionByKey = new Map();
  const versionKeyVariants = (title) => {
    const full = normalizeTitle(title);
    const stripped = normalizeTitle(
      String(title)
        .replace(/^maimai\s*/i, '')
        .replace(/^でらっくす\s*/i, '')
        .replace(/^舞萌DX\s*/i, ''),
    );
    return [full, stripped].filter(Boolean);
  };
  for (const entry of [...catalog.versions, ...prevExtraVersions.values()]) {
    for (const key of versionKeyVariants(entry.title)) {
      if (!versionByKey.has(key)) versionByKey.set(key, entry);
    }
  }
  let maxVersionId = Math.max(
    0,
    ...[...catalog.versions, ...prevExtraVersions.values()].map((entry) => Number(entry.id) || 0),
  );
  /** @type {Map<number, { id: number, title: string, version: number }>} */
  const packVersion = new Map();
  const newVersions = [];
  const getVersionEntry = (pack) => {
    const cached = packVersion.get(pack.num);
    if (cached) return cached;
    let entry = null;
    for (const key of versionKeyVariants(pack.versionTitle)) {
      const hit = versionByKey.get(key);
      if (hit) {
        entry = hit;
        break;
      }
    }
    if (!entry) {
      maxVersionId += 1;
      entry = { id: maxVersionId, title: pack.versionTitle, version: maxVersionId };
      for (const key of versionKeyVariants(entry.title)) versionByKey.set(key, entry);
      newVersions.push(entry);
      log(`  新版本：${entry.title}（id=${entry.id}）`);
    }
    packVersion.set(pack.num, entry);
    return entry;
  };

  const existingIds = new Set([...baselineIds, ...prevExtraSongs.keys()]);
  const existingChartFileIds = new Set();
  for (const song of catalog.songs) {
    for (const kind of ['standard', 'dx']) {
      if ((song.difficulties?.[kind] ?? []).length) {
        existingChartFileIds.add(kind === 'dx' ? Number(song.id) + 10000 : Number(song.id));
      }
    }
    if ((song.difficulties?.utage ?? []).length) existingChartFileIds.add(Number(song.id));
  }

  const simaiDir = path.join(PUBLIC_DIR, 'simai');
  /** @type {Map<number, any>} */
  const extraSongs = new Map();
  /** 普通谱面（供 Bot 曲库补充数据使用，含宴谱过滤） */
  const supplementEntries = [];
  /** @type {{ pack: number, packName: string, folder: string, reason: string }[]} */
  const unmatched = [];
  const stats = {
    packs: packs.length,
    entries: 0,
    covered: 0,
    updated: 0,
    utageSkipped: 0,
    added: 0,
    unmatched: 0,
    errors: 0,
  };

  for (const pack of packs) {
    if (args.maxPacks && pack.num > args.maxPacks) continue;
    let central;
    try {
      central = await source.readCentralDirectory(pack);
    } catch (error) {
      stats.errors += 1;
      log(`  ${pack.name}: 读取失败 ${error.message}`);
      continue;
    }
    const maidataEntries = central.entries.filter((entry) => entry.name.endsWith('/maidata.txt'));
    let addedInPack = 0;
    // 并发读取 maidata（每个条目一次 HTTP Range 请求）
    const texts = new Array(maidataEntries.length);
    {
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= maidataEntries.length) return;
          try {
            texts[index] = (await source.readEntry(central.source, maidataEntries[index])).toString('utf8');
          } catch (error) {
            texts[index] = new Error(error.message);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, maidataEntries.length || 1) }, worker));
    }
    for (let entryIndex = 0; entryIndex < maidataEntries.length; entryIndex += 1) {
      const entry = maidataEntries[entryIndex];
      stats.entries += 1;
      const folder = entry.name.split('/').slice(-2, -1)[0] ?? pack.name;
      const textOrError = texts[entryIndex];
      if (textOrError instanceof Error) {
        stats.errors += 1;
        unmatched.push({ pack: pack.num, packName: pack.name, folder, reason: `读取失败：${textOrError.message}` });
        continue;
      }
      const text = textOrError;
      const meta = parseMaidataMeta(text);
      const utage = isUtageMaidata(text);
      if (!utage) supplementEntries.push({ pack, folder, meta, text });
      const keys = titleKeys(folder, meta.title);
      const catalogHit = [...keys].some((key) => catalogByTitle.has(key));
      if (utage) {
        if (catalogHit) stats.covered += 1;
        else stats.utageSkipped += 1;
        continue;
      }
      if (catalogHit) {
        stats.covered += 1;
        if (args.refreshAll) {
          // 现有曲目：仅当等级标签完全一致时才用 adx 覆盖，避免版本错位
          const song = [...keys].map((key) => catalogByTitle.get(key)).find(Boolean)?.[0];
          if (song) {
            const kind = guessKind(meta, folder, { difficulties: song.difficulties });
            const rows = song.difficulties?.[kind] ?? [];
            const match = rows.length > 0 && rows.every((row) => String(meta.levels?.[levelKeyOf(row.difficulty)] ?? '') === String(row.level));
            if (match) {
              const chartFileId = kind === 'dx' ? Number(song.id) + 10000 : Number(song.id);
              writeFileIfChanged(path.join(simaiDir, `${chartFileId}.txt`), text);
              stats.updated += 1;
            }
          }
        }
        continue;
      }
      // 目录没有：尝试落雪曲库（CN 已上线曲目），按标题匹配
      let lxnsSong = null;
      for (const key of keys) {
        const hits = lxnsNormalByTitle.get(key);
        if (hits?.length) {
          lxnsSong = hits[0];
          break;
        }
      }
      if (!lxnsSong) {
        stats.unmatched += 1;
        if (unmatched.length < 400) unmatched.push({ pack: pack.num, packName: pack.name, folder, reason: '落雪曲库未找到同名曲目' });
        continue;
      }
      if (existingIds.has(Number(lxnsSong.id)) || extraSongs.has(Number(lxnsSong.id))) continue;
      const versionEntry = getVersionEntry(pack);
      const kind = guessKind(meta, folder, lxnsSong);
      const chartFileId = kind === 'dx' ? Number(lxnsSong.id) + 10000 : Number(lxnsSong.id);
      if (existingChartFileIds.has(chartFileId)) continue;
      const song = buildSongEntry(lxnsSong, kind, meta, versionEntry.id, text);
      extraSongs.set(song.id, song);
      addedInPack += 1;
      stats.added += 1;
    }
    log(`  ${String(pack.num).padStart(2, '0')}. ${pack.versionTitle}：maidata ${maidataEntries.length}，新增曲目 ${addedInPack}`);
  }

  // 写出新增曲目
  let writtenCharts = 0;
  const extraSongsList = [];
  for (const song of [...extraSongs.values()].sort((a, b) => a.id - b.id)) {
    const { _adxChartText: chartText, ...cleanSong } = song;
    const kind = (cleanSong.difficulties.dx ?? []).length ? 'dx' : 'standard';
    const chartFileId = kind === 'dx' ? Number(cleanSong.id) + 10000 : Number(cleanSong.id);
    if (!args.dryRun) {
      if (writeFileIfChanged(path.join(simaiDir, `${chartFileId}.txt`), chartText)) writtenCharts += 1;
    }
    extraSongsList.push(cleanSong);
  }

  // 与历史补丁取并集（新发现的覆盖旧的同 id/同标题条目）
  const extraVersionUnion = new Map(prevExtraVersions);
  for (const version of newVersions) extraVersionUnion.set(Number(version.id), version);
  const extraSongUnion = new Map(prevExtraSongs);
  for (const song of extraSongsList) extraSongUnion.set(Number(song.id), song);
  const extraVersionsFinal = [...extraVersionUnion.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const extraSongsFinal = [...extraSongUnion.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const extraCatalog = { generatedAt: new Date().toISOString(), versions: extraVersionsFinal, songs: extraSongsFinal };
  if (!args.dryRun) {
    writeJson(path.join(DATA_DIR, 'catalog-extra.json'), extraCatalog);
    // 下载站清单
    const downloadPacks = packs.map((pack) => ({
      num: pack.num,
      name: pack.name,
      version: pack.versionTitle,
      size: pack.size,
      sizeLabel: formatSize(pack.size),
      fid: pack.fid,
      file: pack.fileName ?? pack.name,
    }));
    writeJson(path.join(PUBLIC_DIR, 'download-packs.json'), {
      generatedAt: new Date().toISOString(),
      shareUrl: args.shareUrl,
      sharePwd: args.sharePwd,
      totalSize: packs.reduce((sum, pack) => sum + pack.size, 0),
      totalSizeLabel: formatSize(packs.reduce((sum, pack) => sum + pack.size, 0)),
      packs: downloadPacks,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    shareUrl: args.shareUrl,
    mode: source.mode,
    stats: {
      ...stats,
      chartsWritten: writtenCharts,
      extraSongs: extraSongsFinal.length,
      newExtraSongs: extraSongsList.length,
      newVersions: newVersions.length,
    },
    newVersions,
    unmatched: unmatched.slice(0, 400),
    extraSongIds: extraSongsFinal.map((song) => song.id),
  };
  if (!args.dryRun) writeJson(path.join(DATA_DIR, 'report.json'), report);

  // Bot 曲库补充数据（adx 谱面 → 官方 ID 映射；失败不影响主流程）
  if (!args.dryRun) {
    try {
      const supplement = await buildBotSupplement(supplementEntries, { cacheDir: DATA_DIR });
      // Bot 拉取用，紧凑输出（约 1.4MB），不保留缩进
      fs.writeFileSync(path.join(PUBLIC_DIR, 'adx-song-supplement.json'), JSON.stringify(supplement));
      log(
        `Bot 曲库补充数据：${supplement.stats.songs} 首（映射 ${supplement.stats.mapped}，未映射 ${supplement.stats.unmapped}）`,
      );
    } catch (error) {
      log(`Bot 曲库补充数据生成失败：${error.message}`);
    }
  }

  log(
    `完成：maidata ${stats.entries}，目录已覆盖 ${stats.covered}，宴谱跳过 ${stats.utageSkipped}，新增曲目 ${extraSongsList.length}（补丁累计 ${extraSongsFinal.length}，写入谱面 ${writtenCharts}），未匹配 ${stats.unmatched}，错误 ${stats.errors}，耗时 ${(
      (Date.now() - startedAt) / 1000
    ).toFixed(1)}s`,
  );
  if (newVersions.length) log(`新增版本：${newVersions.map((entry) => entry.title).join('、')}`);
  if (args.dryRun) log('（--dry-run：未写入任何文件）');
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
