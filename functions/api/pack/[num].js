/**
 * Cloudflare Pages Function：版本包直链跳转
 *
 * GET /api/pack/<num>   302 → Release 附件直链（public 仓库，无限速、支持断点续传/Range）
 * GET /api/pack/<num>?json=1  返回直链 JSON，便于脚本取用
 *
 * 说明：CNB raw 单文件上限 100MiB，版本包普遍 150MB~1.2GB，故直链托管在 GitHub Release 附件；
 * git 镜像仍在 https://cnb.cool/project-baka86/otoge-db/-/tree/main/adx-packs 作为归档。
 * 大文件走重定向（本 Function 自身有 ~20MB 响应上限，夸克代理线路作为备用）。
 */
const RELEASE_BASE = 'https://github.com/RainCore1115/Maimai-Chart-Preview/releases/download/packs-mirror';

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
  // GitHub 会把附件名里的空格规范成 `.`，这里保持一致
  const assetName = fileName.replace(/ /g, '.');
  const target = `${RELEASE_BASE}/${encodeURIComponent(assetName).replace(/%2F/g, '/')}`;

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
