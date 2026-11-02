/**
 * 由 adx 谱面数据生成 Bot（nonebot_plugin_maimaidx）曲库补充文件。
 *
 * Bot 侧 `core/merge/adx_supplement.py` 读取 `data/adx_music_supplement.json`：
 * 只补录能对上官方 ID 的曲目（ID 取自 dxrating 的 id 映射，绝不猜），
 * 标级/谱师/曲师/BPM 来自 adx 谱面，定数/物量/曲风来自 dxrating dxdata。
 * 产出文件同时发布到预览站，Bot 每 6 小时拉取一次，有新增曲目就推送。
 */
import fs from 'node:fs';
import path from 'node:path';

import { normalizeTitle, parseMaidataMeta } from './catalog.mjs';

const ID_MAP_URL = 'https://cnb.cool/project-baka86/otoge-db/-/git/raw/main/maimai/data/music-id-map.json';
const DXDATA_URL = 'https://cdn.jsdelivr.net/gh/gekichumai/dxrating@main/packages/dxdata/dxdata.json';

const DIFF_KEYS = { basic: 0, advanced: 1, expert: 2, master: 3, remaster: 4 };
//: 个别版本名与插件资源包里的版本图文件名不一致，按图片实际名字修正
const VERSION_TITLE_OVERRIDES = { 12: 'MiLK PLUS' };
const GENRE_MAP = {
  maimai: '舞萌',
  'POPS＆アニメ': '流行&动漫',
  'niconico＆ボーカロイド': 'niconico & VOCALOID',
  東方Project: '东方Project',
  'ゲーム＆バラエティ': '其他游戏',
  'オンゲキ＆CHUNITHM': '音击&中二节奏',
};

async function fetchJson(url, { timeoutMs = 120_000, retries = 3, cacheFile } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'mai-chart-preview' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const parsed = JSON.parse(text);
        if (cacheFile) fs.writeFileSync(cacheFile, text);
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (cacheFile && fs.existsSync(cacheFile)) {
        try {
          return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } catch {
          /* 继续重试 */
        }
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

function headerOf(text, key) {
  const matched = new RegExp(`^&${key}=(.*)$`, 'm').exec(text);
  return matched ? matched[1].trim() : null;
}

function typeOf(folder, text, record) {
  const suffix = /\[(DX|ST)\]\s*$/.exec(folder);
  if (suffix) return suffix[1] === 'DX' ? 'DX' : 'SD';
  const cabinet = (headerOf(text, 'cabinet') || '').toUpperCase();
  if (cabinet === 'DX') return 'DX';
  if (cabinet === 'ST') return 'SD';
  if (record) {
    if (record.SD && !record.DX) return 'SD';
    if (record.DX && !record.SD) return 'DX';
  }
  return null;
}

/** 标题候选（目录里常见的后缀/前缀变化），按优先级返回 */
function titleVariants(folder, title) {
  const variants = [];
  for (const value of [title, folder]) {
    if (!value) continue;
    variants.push(
      value,
      value.replace(/\s*\[(?:DX|ST)\]\s*$/i, ''),
      value.replace(/^\[[^\]]*\]\s*/, ''),
      value.replace(/\s*\[(?:1P|2P|1p|2p)\]\s*/g, ' '),
      value.replace(/\s*\[(?:EASY|HARD|NORMAL|EXPERT|MASTER|RE:MASTER)\]\s*$/i, ''),
      value.replace(/\s*-\s*Copy\s*$/i, ''),
    );
  }
  return [...new Set(variants)];
}

function mapToDef(idMapByTitle, folder, title) {
  for (const key of titleVariants(folder, title)) {
    const hit = idMapByTitle.get(normalizeTitle(key));
    if (hit) return hit;
  }
  return null;
}

function parseBpm(meta, text) {
  const fromMeta = Number(meta.bpm);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  const matched = /\(\s*(\d+(?:\.\d+)?)\s*\)/.exec(text);
  return matched ? Number(matched[1]) : 0;
}

/**
 * @param {{ pack: { num: number, versionTitle: string }, folder: string, meta: object, text: string }[]} entries
 * @param {{ idMap?: object, dxdata?: object, cacheDir?: string }} [options]
 */
export async function buildBotSupplement(entries, options = {}) {
  const cacheDir = options.cacheDir ?? null;
  const idMap = options.idMap ?? (await fetchJson(ID_MAP_URL, { cacheFile: cacheDir ? path.join(cacheDir, 'otoge_music_id_map.json') : undefined }));
  const dxdata = options.dxdata ?? (await fetchJson(DXDATA_URL, { cacheFile: cacheDir ? path.join(cacheDir, 'dxdata.json') : undefined }));

  const idMapByTitle = new Map();
  for (const record of idMap.songs ?? []) {
    const key = normalizeTitle(record.title ?? '');
    if (key) idMapByTitle.set(key, record);
  }
  const dxdataById = new Map();
  for (const song of dxdata.songs ?? []) {
    for (const sheet of song.sheets ?? []) {
      if (sheet.internalId) dxdataById.set(Number(sheet.internalId), song);
    }
  }

  const stats = { entries: entries.length, mapped: 0, unmapped: 0, skipped: 0 };
  const collected = new Map();
  for (const entry of entries) {
    const { folder, meta, text, pack } = entry;
    const title = String(meta.title ?? folder).replace(/\s*\[(DX|ST)\]\s*$/i, '').trim();
    if (!title) {
      stats.skipped += 1;
      continue;
    }
    const record = mapToDef(idMapByTitle, folder, title);
    const type = typeOf(folder, text, record);
    if (!record || !type) {
      stats.unmapped += 1;
      continue;
    }
    const songId = Number(record[type]) || 0;
    if (!songId) {
      stats.unmapped += 1;
      continue;
    }
    const dxSong = dxdataById.get(songId) ?? null;
    const difficulties = [];
    for (let n = 2; n <= 6; n += 1) {
      const level = meta.levels?.[n];
      if (!level) continue;
      const index = n - 2;
      let levelValue = 0;
      let notes = null;
      let designer = String(meta.designers?.[n] ?? headerOf(text, 'des') ?? '').trim();
      let dxLevel = null;
      if (dxSong) {
        for (const sheet of dxSong.sheets ?? []) {
          if (Number(sheet.internalId) !== songId) continue;
          if (DIFF_KEYS[sheet.difficulty] !== index) continue;
          if ((sheet.type === 'dx') !== (type === 'DX')) continue;
          levelValue = Number(sheet.internalLevelValue) || 0;
          dxLevel = sheet.level ?? null;
          const counts = sheet.noteCounts ?? {};
          notes = {
            tap: Number(counts.tap) || 0,
            hold: Number(counts.hold) || 0,
            slide: Number(counts.slide) || 0,
            touch: Number(counts.touch) || 0,
            brk: Number(counts.break) || 0,
          };
          notes.total = notes.tap + notes.hold + notes.slide + notes.touch + notes.brk;
          if (!designer) designer = sheet.noteDesigner ?? '';
          break;
        }
      }
      difficulties.push({
        level_index: index,
        level: String(level),
        level_value: levelValue,
        note_designer: designer,
        notes,
        dx_level: dxLevel,
      });
    }
    if (!difficulties.length) {
      stats.unmapped += 1;
      continue;
    }
    const key = `${songId}:${type}`;
    const previous = collected.get(key);
    if (previous && previous.difficulties.length >= difficulties.length) continue;
    collected.set(key, {
      id: songId,
      type,
      title,
      artist: String(meta.artist ?? ''),
      bpm: parseBpm(meta, text),
      genre: GENRE_MAP[dxSong?.category ?? ''] ?? '其他游戏',
      version: VERSION_TITLE_OVERRIDES[pack.num] ?? pack.versionTitle,
      pack: pack.num,
      difficulties: difficulties.sort((a, b) => a.level_index - b.level_index),
    });
    stats.mapped += 1;
  }

  const songs = [...collected.values()].sort((a, b) => (a.id === b.id ? a.type.localeCompare(b.type) : a.id - b.id));
  return {
    generatedAt: new Date().toISOString(),
    source: 'adx share packs (charts) + dxrating id-map/dxdata (ids, level_value, notes)',
    songs,
    stats: { ...stats, songs: songs.length },
  };
}
