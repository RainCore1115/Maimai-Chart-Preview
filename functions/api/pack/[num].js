/**
 * Cloudflare Pages Function：版本包下载
 *
 * GET /api/pack/<num>            流式中转下载（断点续传 Range 透传，下载名保持原文件名）
 * GET /api/pack/<num>?direct=1   302 → 加速直链（浏览器原生下载/续传）
 * GET /api/pack/<num>?json=1     返回直链与备用地址 JSON，便于脚本取用
 *
 * 体积说明：CNB raw 单文件上限 100MiB，版本包 150MB~1.2GB，故包本体托管在
 * GitHub Release 附件，经 GitHub 加速节点流式转发（多源自动重试）。
 * 归档镜像仍在 https://cnb.cool/project-baka86/otoge-db/-/tree/main/adx-packs 。
 */
const REPO = 'RainCore1115/Maimai-Chart-Preview';
const TAG = 'packs-mirror';
const GH_FILE = `https://github.com/${REPO}/releases/download/${TAG}`;
const MIRRORS = [
  (name) => `https://gh-proxy.com/${GH_FILE}/${name}`,
  (name) => `https://ghfast.top/${GH_FILE}/${name}`,
];
const GH_API = `https://api.github.com/repos/${REPO}/releases/tags/${TAG}`;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
const runtime = { assets: null, assetsAt: 0 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** GitHub 附件名规范化：`. ` 折叠为 `.`，其余空白转 `.` */
function assetNameOf(fileName) {
  return String(fileName).replace(/\.\s+/g, '.').replace(/\s+/g, '.');
}

/** 通过 API 换取有时效的官方直链（镜像全失效时的兜底） */
async function signedUrl(name, env) {
  try {
    const now = Date.now();
    if (!runtime.assets || now - runtime.assetsAt > 10 * 60 * 1000) {
      const res = await fetch(GH_API, {
        headers: { 'user-agent': 'chart-preview', accept: 'application/vnd.github+json', ...(env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}) },
      });
      if (!res.ok) return null;
      const data = await res.json();
      runtime.assets = new Map((data.assets || []).map((item) => [item.name, item.id]));
      runtime.assetsAt = now;
    }
    const id = runtime.assets.get(name);
    if (!id) return null;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, {
      headers: { accept: 'application/octet-stream', ...(env.GH_TOKEN ? { authorization: `Bearer ${env.GH_TOKEN}` } : {}) },
      redirect: 'manual',
    });
    return res.headers.get('location');
  } catch {
    return null;
  }
}

async function relay(target, request) {
  const range = request.headers.get('range');
  const res = await fetch(target, {
    headers: { 'user-agent': 'Mozilla/5.0', ...(range ? { range } : {}) },
    cf: { cacheEverything: false },
  });
  if (res.status !== 200 && res.status !== 206) return null;
  return res;
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
  const target = encodeURIComponent(assetNameOf(fileName));
  const mirrors = MIRRORS.map((build) => build(target));

  if (url.searchParams.has('json')) {
    return json({ ok: true, pack: pack.num, file: fileName, size: pack.size, direct: mirrors[0], mirrors });
  }

  // 直链模式：交给浏览器原生下载（可续传、不占用 Function 时长）
  if (url.searchParams.has('direct')) {
    return new Response(null, {
      status: 302,
      headers: { location: mirrors[0], 'cache-control': 'public, max-age=1800', 'access-control-allow-origin': '*' },
    });
  }

  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  for (const mirror of mirrors) {
    const res = await relay(mirror, request);
    if (!res) continue;
    const headers = new Headers({ 'content-disposition': disposition, 'cache-control': 'public, max-age=1800', 'access-control-allow-origin': '*' });
    for (const name of PASS_HEADERS) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(res.body, { status: res.status, headers });
  }

  // 兜底：官方有时效直链
  const fallback = await signedUrl(assetNameOf(fileName), env ?? {});
  if (fallback) {
    const res = await relay(fallback, request);
    if (res) {
      const headers = new Headers({ 'content-disposition': disposition, 'cache-control': 'public, max-age=600' });
      for (const name of PASS_HEADERS) {
        const value = res.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(res.body, { status: res.status, headers });
    }
  }

  return json({ ok: false, error: '所有下载线路均不可用，请稍后重试或使用网盘中转' }, 502);
}
