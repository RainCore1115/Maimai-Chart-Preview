/**
 * Cloudflare Pages Function：谱面版本包下载代理
 *
 * GET /api/dl?f=<fid>        代理下载夸克分享盘中的版本包（支持 Range 断点续传）
 * GET /api/dl?status=1       返回代理状态与版本包数量
 *
 * 为什么需要代理：夸克分享的大文件（>90MB）直链必须带登录 Cookie，浏览器匿名访问会
 * 412/23018；本 Function 用站点密钥里的 QUARK_COOKIE 解析直链并流式转发。
 *
 * 环境变量（Cloudflare Pages 项目 → Settings → Variables and Secrets）：
 *   QUARK_COOKIE      夸克网盘登录 Cookie（必需；约 1 个月需重新扫码更新）
 *   QUARK_SHARE_URL   可选，默认 https://pan.quark.cn/s/485e4886edd4
 *   QUARK_SHARE_PWD   可选，默认 chXQ
 */
const QUARK_API = 'https://drive-pc.quark.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const DEFAULT_SHARE_URL = 'https://pan.quark.cn/s/485e4886edd4';
const DEFAULT_SHARE_PWD = 'chXQ';
const STOKEN_TTL_MS = 25 * 60 * 1000;

/** 单 isolate 内缓存（多个请求复用，避免频繁请求夸克） */
const runtime = {
  /** @type {string|null} */
  cookie: null,
  /** @type {string|null} */
  stoken: null,
  stokenAt: 0,
  /** @type {Map<string, { url: string, at: number }>} */
  links: new Map(),
  /** @type {any[]|null} */
  packs: null,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function sharePwdId(shareUrl) {
  const matched = /\/s\/([0-9a-zA-Z]+)/.exec(shareUrl);
  if (!matched) throw new Error(`无法识别的夸克分享链接：${shareUrl}`);
  return matched[1];
}

function shareConfig(env) {
  return {
    url: (env.QUARK_SHARE_URL || DEFAULT_SHARE_URL).trim(),
    pwd: (env.QUARK_SHARE_PWD || DEFAULT_SHARE_PWD).trim(),
  };
}

function getCookie(env) {
  if (runtime.cookie) return runtime.cookie;
  const raw = env.QUARK_COOKIE;
  if (!raw) throw new Error('站点未配置 QUARK_COOKIE，下载代理不可用');
  runtime.cookie = String(raw).trim().replace(/^["']|["']$/g, '');
  return runtime.cookie;
}

/** 夸克接口请求 */
async function quarkJson(path, { method = 'GET', body, env } = {}) {
  const cookie = getCookie(env);
  const res = await fetch(`${QUARK_API}${path}`, {
    method,
    headers: {
      'user-agent': UA,
      referer: 'https://pan.quark.cn/',
      origin: 'https://pan.quark.cn',
      accept: 'application/json, text/plain, */*',
      cookie,
      ...(body ? { 'content-type': 'application/json;charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`夸克接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
  }
}

/** 刷新 __puus（夸克登录态凭证，约 1 小时过期）；失败时保留原 Cookie */
async function refreshPuus(env) {
  const cookie = getCookie(env);
  if (!cookie.includes('__pus=')) return false;
  try {
    const res = await fetch(`${QUARK_API}/1/clouddrive/auth/pc/flush?pr=ucpro&fr=pc&uc_param_str=`, {
      headers: {
        'user-agent': UA,
        referer: 'https://pan.quark.cn/',
        cookie,
      },
    });
    /** @type {string[]} */
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') setCookies = res.headers.getSetCookie();
    else {
      const raw = res.headers.get('set-cookie');
      if (raw) setCookies = raw.split(/,(?=\s*[^;=]+=)/);
    }
    let newPuus = null;
    for (const item of setCookies) {
      const matched = /(^|,\s*)__puus=([^;]+)/.exec(item);
      if (matched) {
        newPuus = `__puus=${matched[2]}`;
        break;
      }
    }
    if (!newPuus) return false;
    // 替换/追加 __puus
    const parts = runtime.cookie.split(/;\s*/).filter(Boolean).filter((part) => !part.startsWith('__puus='));
    parts.push(newPuus);
    runtime.cookie = parts.join('; ');
    return true;
  } catch {
    return false;
  }
}

/** 获取分享 stoken（公开接口，无需登录） */
async function ensureStoken(env) {
  if (runtime.stoken && Date.now() - runtime.stokenAt < STOKEN_TTL_MS) return runtime.stoken;
  const share = shareConfig(env);
  const data = await quarkJson('/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc', {
    method: 'POST',
    env,
    body: { pwd_id: sharePwdId(share.url), passcode: share.pwd },
  });
  const stoken = data?.data?.stoken;
  if (!stoken) throw new Error(`获取夸克 stoken 失败（code=${data?.code}）：${data?.message ?? ''}`);
  runtime.stoken = stoken;
  runtime.stokenAt = Date.now();
  return stoken;
}

/** 解析文件直链；遇登录态失效时刷新 __puus 重试一次 */
async function resolveDownloadUrl(env, fid) {
  const cached = runtime.links.get(fid);
  if (cached && Date.now() - cached.at < 20 * 60 * 1000) return cached.url;
  const share = shareConfig(env);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stoken = await ensureStoken(env);
    const data = await quarkJson('/1/clouddrive/file/download?pr=ucpro&fr=pc', {
      method: 'POST',
      env,
      body: { fids: [fid], pwd_id: sharePwdId(share.url), stoken },
    });
    const first = (data?.data ?? [])[0] ?? {};
    if (data?.code === 0 && first.download_url) {
      runtime.links.set(fid, { url: first.download_url, at: Date.now() });
      return first.download_url;
    }
    // 31001/31002: 未登录/Cookie 失效；刷新 __puus 后再试
    if ((data?.code === 31001 || data?.code === 31002) && attempt === 0) {
      const refreshed = await refreshPuus(env);
      runtime.stoken = null;
      if (refreshed) continue;
    }
    throw new Error(`获取下载直链失败（code=${data?.code}）：${data?.message ?? JSON.stringify(data).slice(0, 200)}`);
  }
  throw new Error('获取下载直链失败');
}

/** 读取版本包清单（构建产物 public/data/download-packs.json） */
async function loadPacks(request, env) {
  if (runtime.packs) return runtime.packs;
  const url = new URL('/data/download-packs.json', request.url);
  let res;
  if (env?.ASSETS?.fetch) res = await env.ASSETS.fetch(new Request(url.toString(), { headers: { accept: 'application/json' } }));
  else res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`读取版本包清单失败：HTTP ${res.status}`);
  const data = await res.json();
  runtime.packs = Array.isArray(data?.packs) ? data.packs : [];
  return runtime.packs;
}

async function handle(request, env, { head = false } = {}) {
  const url = new URL(request.url);
  const share = shareConfig(env);

  if (url.searchParams.has('status')) {
    let packs = [];
    try {
      packs = await loadPacks(request, env);
    } catch {
      packs = [];
    }
    return json({
      ok: Boolean(env.QUARK_COOKIE),
      cookieConfigured: Boolean(env.QUARK_COOKIE),
      shareUrl: share.url,
      sharePwd: share.pwd,
      packs: packs.length,
      totalSize: packs.reduce((sum, pack) => sum + (Number(pack.size) || 0), 0),
    });
  }

  const fid = (url.searchParams.get('f') || '').trim();
  if (!fid) return json({ ok: false, error: '缺少参数 f（版本包 fid）' }, 400);

  let packs;
  let pack;
  try {
    packs = await loadPacks(request, env);
    pack = packs.find((item) => String(item.fid) === fid);
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 502);
  }
  if (!pack) return json({ ok: false, error: '未知的版本包' }, 404);

  // 断点续传：透传浏览器的 Range 头
  const range = request.headers.get('range');
  let upstream;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const link = await resolveDownloadUrl(env, fid);
      upstream = await fetch(link, {
        method: head ? 'HEAD' : 'GET',
        headers: {
          'user-agent': UA,
          referer: 'https://pan.quark.cn/',
          cookie: getCookie(env),
          ...(range ? { range } : {}),
        },
      });
      if (upstream.status === 200 || upstream.status === 206 || upstream.status === 416) break;
      if ((upstream.status === 403 || upstream.status === 412) && attempt === 0) {
        // 直链被拒：刷新登录态后重新解析
        runtime.links.delete(fid);
        await refreshPuus(env);
        continue;
      }
      lastError = `上游返回 HTTP ${upstream.status}`;
      break;
    } catch (error) {
      lastError = String(error?.message ?? error);
      if (attempt === 0) {
        runtime.links.delete(fid);
        await refreshPuus(env);
      }
    }
  }
  if (!upstream) return json({ ok: false, error: lastError || '下载失败' }, 502);
  if (upstream.status >= 400 && upstream.status !== 416) {
    return json({ ok: false, error: lastError || `上游返回 HTTP ${upstream.status}` }, 502);
  }

  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('content-type')) headers.set('content-type', 'application/zip');
  headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(pack.file ?? pack.name ?? 'pack.zip')}`);
  headers.set('cache-control', 'private, max-age=0, no-store');

  if (head) return new Response(null, { status: upstream.status, headers });
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function onRequestGet(context) {
  try {
    return await handle(context.request, context.env);
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 500);
  }
}

export async function onRequestHead(context) {
  try {
    return await handle(context.request, context.env, { head: true });
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 500);
  }
}
