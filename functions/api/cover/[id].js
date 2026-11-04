// 曲绘封面代理：源站为 mai-charts 仓库 covers/，用 Cache API 缓存避免被源站限流
export async function onRequest(context) {
  const { params } = context;
  const raw = String(params.id || '');
  const id = raw.replace(/\.webp$/i, '');
  if (!/^\d+$/.test(id)) return new Response('bad id', { status: 400 });

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://cover-cache.internal/${id}.webp`);

  let hit = cache ? await cache.match(cacheKey) : null;
  if (hit) return hit;

  const upstream = `https://cnb.cool/project-baka86/mai-charts/-/git/raw/main/covers/${id}.webp`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(upstream, { headers: { accept: 'image/webp,image/*' } });
    if (res.ok) {
      const out = new Response(res.body, {
        headers: {
          'content-type': 'image/webp',
          'cache-control': 'public, max-age=604800, immutable',
          'access-control-allow-origin': '*',
        },
      });
      if (cache) await cache.put(cacheKey, out.clone());
      return out;
    }
    if (res.status !== 429 && res.status < 500) return new Response('not found', { status: 404 });
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return new Response('upstream busy', { status: 502 });
}
