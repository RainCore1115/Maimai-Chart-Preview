const TARGETS = {
  proxy: 'https://gh-proxy.com/https://github.com/RainCore1115/Maimai-Chart-Preview/releases/download/packs-mirror/28.MAGiCAL.zip',
};
export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const key = u.searchParams.get('t') || 'proxy';
  const up = await fetch(TARGETS[key], { headers: { 'user-agent': 'Mozilla/5.0' } });
  const h = new Headers();
  for (const n of ['content-type', 'content-length', 'accept-ranges']) {
    const v = up.headers.get(n);
    if (v) h.set(n, v);
  }
  return new Response(up.body, { status: up.status, headers: h });
}
