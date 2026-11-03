export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const target = u.searchParams.get('u');
  if (!target) return new Response('missing u', { status: 400 });
  const up = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0' } });
  const h = new Headers();
  for (const n of ['content-type', 'content-length', 'accept-ranges']) {
    const v = up.headers.get(n);
    if (v) h.set(n, v);
  }
  return new Response(up.body, { status: up.status, headers: h });
}
