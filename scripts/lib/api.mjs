/**
 * AWMC chart-preview API 客户端
 *
 * 文档：https://wiki.awmc.team/dev/chart-preview-api
 * 基础地址：https://v.wmc.pub/api/v1（可用 CHART_PREVIEW_API_BASE 覆盖）
 * 鉴权：Authorization: Bearer <API Key>（CHART_PREVIEW_API_KEY）
 */

export const DEFAULT_API_BASE = 'https://v.wmc.pub/api/v1';

export class ChartPreviewApi {
  /** @param {{ base?: string, apiKey?: string, concurrency?: number, timeoutMs?: number }} [options] */
  constructor(options = {}) {
    this.base = (options.base ?? process.env.CHART_PREVIEW_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? process.env.CHART_PREVIEW_API_KEY ?? '';
    this.concurrency = options.concurrency ?? 4;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    if (!this.apiKey) throw new Error('缺少 CHART_PREVIEW_API_KEY（chart-preview API Key）');
    this.requestCount = 0;
  }

  /** @param {string} path @param {{ method?: string, retries?: number }} [options] */
  async request(path, options = {}) {
    const { method = 'GET', retries = 4 } = options;
    const url = `${this.base}${path.startsWith('/') ? path : `/${path}`}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      this.requestCount += 1;
      try {
        const res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 800 * 2 ** attempt);
          lastError = new Error(`HTTP ${res.status} ${url}`);
          await sleep(waitMs);
          continue;
        }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${(await res.text()).slice(0, 300)}`);
        return await res.json();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * 列出谱面（分页，limit 最大 50）。
   * @param {{ page?: number, limit?: number, kind?: string, difficulty?: number, q?: string, sort?: string }} [params]
   */
  listCharts(params = {}) {
    const search = new URLSearchParams();
    if (params.page) search.set('page', String(params.page));
    search.set('limit', String(params.limit ?? 50));
    if (params.kind) search.set('kind', params.kind);
    if (params.difficulty) search.set('difficulty', String(params.difficulty));
    if (params.q) search.set('q', params.q);
    if (params.sort) search.set('sort', params.sort);
    return this.request(`/charts?${search.toString()}`);
  }

  /** 拉取全量谱面列表（自动翻页）。 */
  async listAllCharts(onProgress) {
    /** @type {any[]} */
    const items = [];
    let page = 1;
    let total = Infinity;
    for (;;) {
      const data = await this.listCharts({ page, limit: 50 });
      const batch = data?.items ?? [];
      total = data?.total ?? total;
      items.push(...batch);
      onProgress?.({ page, loaded: items.length, total });
      if (batch.length === 0 || items.length >= total) break;
      page += 1;
      if (page > 500) break;
    }
    return { items, total };
  }

  /** @param {string} chartKey 形如 `417:standard:5` */
  chartDetail(chartKey) {
    return this.request(`/charts/${encodeURIComponent(chartKey)}`);
  }

  /** @param {string} chartKey */
  chartTags(chartKey, params = {}) {
    const search = new URLSearchParams();
    if (params.radar_threshold) search.set('radar_threshold', String(params.radar_threshold));
    if (params.feature_threshold) search.set('feature_threshold', String(params.feature_threshold));
    const qs = search.toString();
    return this.request(`/charts/${encodeURIComponent(chartKey)}/tags${qs ? `?${qs}` : ''}`);
  }

  /** 并发执行任务（用于批量拉取谱面详情）。 */
  async pool(items, worker, concurrency = this.concurrency) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
