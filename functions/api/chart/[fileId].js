/**
 * Cloudflare Pages Function：单谱面文件下载
 *
 * GET /api/chart/<chartFileId>?diff=<2..6>  → 以 `<曲名> [DX|ST] [难度].maidata.txt`
 *     下载指定难度的谱面文本（maidata 格式，仅保留该难度）
 * GET /api/chart/<chartFileId>               → 下载该曲目的完整 maidata（含全部难度）
 *
 * chartFileId：标准谱 = songId，DX 谱 = songId + 10000，宴谱 = 10000 + 曲目 id 段。
 * 谱面文本来自站点静态资源 /data/simai/<chartFileId>.txt。
 */
const DIFF_NAMES = { 2: 'BASIC', 3: 'ADVANCED', 4: 'EXPERT', 5: 'MASTER', 6: 'RE:MASTER' };
//: 站点未收录的谱面回落到 adx 谱面仓库（公共只读 raw，含日服/下架曲）
const ADX_CHARTS_RAW = 'https://cnb.cool/sulieripple/mai-charts/-/git/raw/main/charts';
let metaCache = null;
const KEEP_ALWAYS = ['title', 'artist', 'wholebpm', 'cabinet', 'genre'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fileNameFor(chartFileId, text, diff) {
  const matched = /^&title=(.*)$/m.exec(text);
  const rawTitle = (matched ? matched[1] : String(chartFileId)).trim();
  const title = rawTitle
    .replace(/\s*\[(?:DX|ST|1P|2P)\]\s*$/gi, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  const kind = chartFileId >= 10000 ? 'DX' : 'ST';
  const diffLabel = diff ? DIFF_NAMES[diff] : null;
  const suffix = [kind, diffLabel].filter(Boolean).join('] [');
  return `${title || chartFileId} [${suffix}].maidata.txt`;
}


/** 从 zip（.adx 包）里取 maidata.txt 文本 */
async function extractMaidata(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const dec = new TextDecoder('utf-8');
  let eocd = -1;
  const min = Math.max(0, u8.length - 65558);
  for (let i = u8.length - 22; i >= min; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) return null;
    const method = dv.getUint16(ptr + 10, true);
    const csize = dv.getUint32(ptr + 20, true);
    const nlen = dv.getUint16(ptr + 28, true);
    const elen = dv.getUint16(ptr + 30, true);
    const clen = dv.getUint16(ptr + 32, true);
    const lho = dv.getUint32(ptr + 42, true);
    const name = dec.decode(u8.subarray(ptr + 46, ptr + 46 + nlen)).toLowerCase();
    ptr += 46 + nlen + elen + clen;
    if (!name.endsWith('maidata.txt')) continue;
    if (dv.getUint32(lho, true) !== 0x04034b50) return null;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method === 0) return dec.decode(data);
    if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    return null;
  }
  return null;
}

/**
 * adx 包里的难度下标从 1 开始（1=BASIC…5=MASTER、6=RE:MASTER），站点下标从 2 开始。
 * 优先用等级值把「请求的难度」对上 adx 下标，再按同一偏移改写全部难度键。
 */
function shiftDifficultyKeys(text, siteLevels, diff) {
  const levels = new Map();
  for (const line of text.split(/\r?\n/)) {
    const matched = /^&lv_(\d+)=(.*)$/i.exec(line);
    if (matched) levels.set(Number(matched[1]), matched[2].trim());
  }
  const siteIndexes = Object.keys(siteLevels).map(Number).sort((a, b) => a - b);
  const adxIndexes = [...levels.keys()].sort((a, b) => a - b);
  let shift = null;

  // 1) 优先按「请求难度的等级值」定位 adx 下标
  const expected = siteLevels[diff];
  if (expected) {
    const hits = adxIndexes.filter((index) => levels.get(index) === expected);
    if (hits.length) {
      hits.sort((a, b) => Math.abs(a - diff) - Math.abs(b - diff));
      shift = diff - hits[0];
    }
  }
  // 2) 数量一致时按首项对齐（同一偏移）
  if (shift === null && siteIndexes.length && adxIndexes.length && siteIndexes.length === adxIndexes.length) {
    shift = siteIndexes[0] - adxIndexes[0];
  }
  // 3) 兜底：把 adx 的最前一项对齐到站点第一项
  if (shift === null) shift = (siteIndexes[0] ?? 2) - (adxIndexes[0] ?? 1);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const matched = /^&(lv|des|inote)_(\d+)=(.*)$/i.exec(line);
    if (!matched) {
      out.push(line);
      continue;
    }
    const siteIndex = Number(matched[2]) + shift;
    if (siteIndex < 2 || siteIndex > 6) continue;
    out.push(`&${matched[1]}_${siteIndex}=${matched[3]}`);
  }
  return out.join('\n');
}

/** 站点未收录时的标题/等级来源：adx 补充数据（id → 曲名 + 各难度等级），单 isolate 缓存 */
async function loadChartMeta(url, env) {
  if (metaCache) return metaCache;
  const map = new Map();
  try {
    const res = await env.ASSETS.fetch(new URL('/data/adx-song-supplement.json', url.origin).toString());
    if (res.ok) {
      const data = await res.json();
      for (const song of data?.songs ?? []) {
        const levels = {};
        for (const row of song.difficulties ?? []) levels[Number(row.level_index) + 2] = String(row.level ?? '').trim();
        map.set(Number(song.id), { title: String(song.title ?? ''), levels });
      }
    }
  } catch {
    /* 忽略：仅影响回落 */
  }
  if (map.size) metaCache = map;
  return map;
}

/** 从 adx 谱面仓库取文本；标准谱/ DX 谱用文件名后缀区分 */
async function fetchRemoteChart(chartFileId, diff, url, env) {
  const metas = await loadChartMeta(url, env);
  const meta = metas.get(chartFileId % 10000);
  const title = meta?.title;
  if (!title) return null;
  const kind = chartFileId >= 10000 ? 'DX' : 'ST';
  const candidates = kind === 'DX' ? [`${title} [DX].adx`, `${title}.adx`] : [`${title}.adx`, `${title} [ST].adx`];
  for (const name of candidates) {
    try {
      const res = await fetch(`${ADX_CHARTS_RAW}/${encodeURIComponent(name).replace(/%2F/g, '/')}`);
      if (!res.ok) continue;
      const packed = await extractMaidata(await res.arrayBuffer());
      if (packed && packed.trim()) return shiftDifficultyKeys(packed, meta.levels ?? {}, diff);
      if (packed === null) return null;
      return null;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

export async function onRequestGet({ request, params, env }) {
  const rawId = String(params.fileId || '').replace(/[^\d]/g, '');
  if (!rawId) return json({ ok: false, error: '谱面 ID 无效' }, 400);
  const chartFileId = Number(rawId);
  const url = new URL(request.url);
  const diff = Number(url.searchParams.get('diff') || 0);
  if (diff && !DIFF_NAMES[diff]) return json({ ok: false, error: '难度参数应为 2-6' }, 400);

  const assets = env?.ASSETS;
  if (!assets) return json({ ok: false, error: '缺少 ASSETS 绑定' }, 500);
  const assetUrl = new URL(`/data/simai/${chartFileId}.txt`, url.origin);
  const res = await assets.fetch(assetUrl.toString());
  let text = res.ok ? await res.text() : '';
  let source = 'site';
  if (!text.trim()) {
    const remote = await fetchRemoteChart(chartFileId, diff, url, env);
    if (!remote) return json({ ok: false, error: '没有该谱面数据（可能未收录）' }, 404);
    text = remote;
    source = 'adx';
  }

  let body = text;
  if (diff) {
    const picked = [];
    let lastKey = '';
    for (const line of text.split(/\r?\n/)) {
      const head = /^&([a-z_0-9]+)=/i.exec(line);
      if (head) {
        lastKey = head[1].toLowerCase();
        const keepAlways = KEEP_ALWAYS.includes(lastKey.replace(/_\d+$/, ''));
        const sameDiff = new RegExp(`^&(?:lv|des|inote)_${diff}=`, 'i').test(line);
        if (keepAlways || sameDiff) picked.push(line);
        continue;
      }
      // 谱面正文（&inote_N= 之后的续行）一并保留
      if (lastKey === `inote_${diff}`) picked.push(line);
    }
    if (!picked.some((line) => /^&inote_\d+=/i.test(line))) {
      return json({
        ok: false,
        error: `该谱面没有 ${DIFF_NAMES[diff]} 难度`,
        debug: { source, textLen: text.length, picked: picked.length, head: picked.join('\n').slice(0, 300) },
      }, 404);
    }
    body = `${picked.join('\n')}\n`;
  }

  const fileName = fileNameFor(chartFileId, text, diff);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'x-chart-source': source,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
