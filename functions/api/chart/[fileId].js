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
  if (!res.ok) return json({ ok: false, error: '没有该谱面数据（可能未收录）' }, 404);
  const text = await res.text();

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
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
