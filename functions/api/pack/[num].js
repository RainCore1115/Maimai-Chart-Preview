/**
 * Cloudflare Pages Function：版本包 CNB 直链跳转
 *
 * GET /api/pack/<num>   302 → CNB 仓库里的同名 zip（public 仓库，无限速、支持断点续传）
 * GET /api/pack/<num>?json=1  返回直链 JSON，便于脚本取用
 *
 * zip 镜像仓库：https://cnb.cool/project-baka86/otoge-db/-/tree/main/adx-packs
 * 大文件走重定向（本 Function 自身有 ~20MB 响应上限，夸克代理线路作为备用）。
 */
const CNB_RAW = 'https://cnb.cool/project-baka86/otoge-db/-/git/raw/main/adx-packs';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestGet({ request, params, env }) {
  const num = Number(String(params.num || '').replace(/[^\d]/g, ''));
  const url = new URL(request.url);
  const assets = env?.ASSETS;
  if (!assets) return json({ ok: false, error: '缺少 ASSETS 绑定' }, 500);
  if (!Number.isInteger(num) || num < 0) return json({ ok: false, error: '版本包编号无效' }, 400);

  let packs = [];
  try {
    const res = await assets.fetch(new URL('/data/download-packs.json', url.origin).toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    packs = Array.isArray(data?.packs) ? data.packs : [];
  } catch (error) {
    return json({ ok: false, error: `读取版本包清单失败：${error.message}` }, 502);
  }

  const pack = packs.find((item) => Number(item.num) === num);
  if (!pack) return json({ ok: false, error: '未知的版本包' }, 404);

  const fileName = String(pack.file || `${String(pack.num).padStart(2, '0')}.zip`);
  const target = `${CNB_RAW}/${encodeURIComponent(fileName).replace(/%2F/g, '/')}`;

  if (url.searchParams.has('json')) {
    return json({ ok: true, pack: pack.num, file: fileName, size: pack.size, url: target });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}
