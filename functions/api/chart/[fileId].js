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
let titleCache = null;
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

/** 站点未收录时的标题来源：adx 补充数据（id → 曲名），单 isolate 缓存 */
async function loadTitles(url, env) {
  if (titleCache) return titleCache;
  const map = new Map();
  try {
    const res = await env.ASSETS.fetch(new URL('/data/adx-song-supplement.json', url.origin).toString());
    if (res.ok) {
      const data = await res.json();
      for (const song of data?.songs ?? []) map.set(Number(song.id), String(song.title ?? ''));
    }
  } catch {
    /* 忽略：仅影响回落标题 */
  }
  if (map.size) titleCache = map;
  return map;
}

/** 从 adx 谱面仓库取文本；标准谱/ DX 谱用文件名后缀区分 */
async function fetchRemoteChart(chartFileId, url, env) {
  const titles = await loadTitles(url, env);
  const title = titles.get(chartFileId % 10000);
  if (!title) return null;
  const kind = chartFileId >= 10000 ? 'DX' : 'ST';
  const candidates = kind === 'DX' ? [`${title} [DX].adx`, `${title}.adx`] : [`${title}.adx`, `${title} [ST].adx`];
  for (const name of candidates) {
    try {
      const res = await fetch(`${ADX_CHARTS_RAW}/${encodeURIComponent(name).replace(/%2F/g, '/')}`);
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) return text;
      }
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
    const remote = await fetchRemoteChart(chartFileId, url, env);
    if (!remote) return json({ ok: false, error: '没有该谱面数据（可能未收录）' }, 404);
    text = remote;
    source = 'adx';
  }

  let body = text;
  if (diff) {
    const lines = text.split(/\r?\n/);
    const picked = [];
    for (const line of lines) {
      const head = /^&([a-z_0-9]+)=/i.exec(line);
      if (!head) {
        continue;
      }
      const key = head[1].toLowerCase();
      const keepAlways = KEEP_ALWAYS.includes(key.replace(/_\d+$/, ''));
      const sameDiff = new RegExp(`^&(?:lv|des|inote)_${diff}=`, 'i').test(line);
      if (keepAlways || sameDiff) picked.push(line);
    }
    if (!picked.some((line) => /^&inote_\d+=/i.test(line))) {
      return json({ ok: false, error: `该谱面没有 ${DIFF_NAMES[diff]} 难度` }, 404);
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
