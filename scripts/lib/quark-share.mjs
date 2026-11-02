/**
 * 夸克网盘分享盘数据源（netdisk-fast-download / 夸克公开 API）
 *
 * 支持两种模式：
 *  - resolver：通过本机部署的 netdisk-fast-download（默认 http://127.0.0.1:6400）解析分享与直链；
 *  - direct：直接调用夸克网盘 API（需要 `QUARK_COOKIE`，以及 `QUARK_SHARE_URL`/`QUARK_SHARE_PWD`）。
 *
 * 大文件（> 90MB）夸克访客无法直链，必须有登录 Cookie。拿到直链后本模块用 HTTP Range
 * 只读取 ZIP 中央目录和需要的条目，因此下载一个 1GB 的版本包只要几百 KB 流量。
 */
import zlib from 'node:zlib';

const QUARK_API = 'https://drive-pc.quark.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

export const DEFAULT_SHARE_URL = 'https://pan.quark.cn/s/485e4886edd4';
export const DEFAULT_SHARE_PWD = 'chXQ';

/** 解析分享链接，取出 pwd_id（形如 /s/<id>） */
export function sharePwdId(shareUrl) {
  const match = /\/s\/([0-9a-zA-Z]+)/.exec(shareUrl);
  if (!match) throw new Error(`无法识别的夸克分享链接：${shareUrl}`);
  return match[1];
}

function cookieHeader(cookie) {
  return cookie ? { cookie } : {};
}

/** 夸克 API 请求（JSON） */
async function quarkJson(path, { method = 'GET', body, cookie, referer = 'https://pan.quark.cn/' } = {}) {
  const res = await fetch(`${QUARK_API}${path}`, {
    method,
    headers: {
      'user-agent': UA,
      referer,
      origin: 'https://pan.quark.cn',
      accept: 'application/json, text/plain, */*',
      ...(body ? { 'content-type': 'application/json;charset=UTF-8' } : {}),
      ...cookieHeader(cookie),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`夸克接口返回非 JSON（${res.status}）：${text.slice(0, 200)}`);
  }
  return json;
}

/**
 * 分享盘数据源。
 */
export class QuarkShareSource {
  /**
   * @param {{
   *   mode?: 'resolver' | 'direct',
   *   resolverBase?: string,
   *   shareUrl?: string,
   *   sharePwd?: string,
   *   cookie?: string,
   *   logger?: (msg: string) => void,
   * }} options
   */
  constructor(options = {}) {
    this.mode = options.mode ?? (options.resolverBase ? 'resolver' : 'direct');
    this.resolverBase = (options.resolverBase ?? process.env.NFD_BASE ?? '').replace(/\/+$/, '');
    this.shareUrl = options.shareUrl ?? process.env.QUARK_SHARE_URL ?? DEFAULT_SHARE_URL;
    this.sharePwd = options.sharePwd ?? process.env.QUARK_SHARE_PWD ?? DEFAULT_SHARE_PWD;
    this.cookie = options.cookie ?? process.env.QUARK_COOKIE ?? '';
    this.log = options.logger ?? (() => {});
    this.stoken = null;
    this._packs = null;
    this._rootCache = null;
    /** @type {Map<string, any[]>} */
    this._dirCache = new Map();
    /** @type {Map<string, { url: string, headers: Record<string,string>, expiresAt: number }>} */
    this._links = new Map();
  }

  /** 列出分享根目录下的文件/目录（resolver 模式走 /v2/getFileList） */
  async listRoot() {
    if (this._rootCache) return this._rootCache;
    if (this.mode === 'resolver') {
      const url = `${this.resolverBase}/v2/getFileList?url=${encodeURIComponent(this.shareUrl)}&pwd=${encodeURIComponent(this.sharePwd)}`;
      const json = await this._resolverJson(url);
      this._rootCache = (json.data ?? []).map((item) => ({
        fid: item.fileId,
        name: item.fileName,
        size: item.size ?? 0,
        folder: item.fileType === 'folder',
        parserUrl: item.parserUrl,
      }));
      return this._rootCache;
    }
    await this._ensureStoken();
    const json = await quarkJson(
      `/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${sharePwdId(this.shareUrl)}&stoken=${encodeURIComponent(this.stoken)}&pdir_fid=0&force=0&_page=1&_size=100&_fetch_banner=1&_fetch_share=1&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
      { cookie: this.cookie },
    );
    this._assertOk(json, '列出分享目录');
    return (json.data?.list ?? []).map((item) => ({
      fid: item.fid,
      name: item.file_name,
      size: item.size ?? 0,
      folder: Boolean(item.dir),
      parserUrl: null,
    }));
  }

  /** 列出某个子目录 */
  async listDir(fid, parserUrl = null) {
    if (this.mode === 'resolver') {
      if (!parserUrl) throw new Error('resolver 模式列出子目录需要 parserUrl');
      const json = await this._resolverJson(parserUrl);
      this._rootCache = (json.data ?? []).map((item) => ({
        fid: item.fileId,
        name: item.fileName,
        size: item.size ?? 0,
        folder: item.fileType === 'folder',
        parserUrl: item.parserUrl,
      }));
      return this._rootCache;
    }
    await this._ensureStoken();
    const json = await quarkJson(
      `/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${sharePwdId(this.shareUrl)}&stoken=${encodeURIComponent(this.stoken)}&pdir_fid=${fid}&force=0&_page=1&_size=100&_fetch_banner=1&_fetch_share=1&_fetch_total=1&_sort=file_type:asc,updated_at:desc`,
      { cookie: this.cookie },
    );
    this._assertOk(json, '列出分享子目录');
    const items = (json.data?.list ?? []).map((item) => ({
      fid: item.fid,
      name: item.file_name,
      size: item.size ?? 0,
      folder: Boolean(item.dir),
      parserUrl: null,
    }));
    this._dirCache.set(fid, items);
    return items;
  }

  /**
   * 读取分享里的文件列表（自动展开根目录下的单个目录）。
   * @returns {Promise<{ fid: string, name: string, size: number }[]>}
   */
  async listFiles() {
    if (this._packs) return this._packs;
    const root = await this.listRoot();
    const files = [];
    for (const item of root) {
      if (!item.folder) {
        files.push({ fid: item.fid, name: item.name, size: item.size });
        continue;
      }
      const children = await this.listDir(item.fid, item.parserUrl);
      for (const child of children) {
        if (child.folder) this.log(`  跳过子目录 ${child.name}`);
        else files.push({ fid: child.fid, name: child.name, size: child.size });
      }
    }
    this._packs = files;
    return files;
  }

  /** 生成某个文件的直链（resolver 模式走 /v2/getFileDownInfo） */
  async downloadLink(fid) {
    const cached = this._links.get(fid);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const packs = await this.listFiles();
    const pack = packs.find((p) => p.fid === fid);
    if (!pack) throw new Error(`分享中找不到文件：${fid}`);
    let source;
    if (this.mode === 'resolver') {
      const listing = await this._resolverListingUrl(fid);
      const json = await this._resolverJson(`${this.resolverBase}/v2/getFileDownInfo/qk/${listing.param}`);
      source = { url: json.downloadUrl, headers: json.downloadHeaders ?? {} };
    } else {
      await this._ensureStoken();
      const json = await quarkJson('/1/clouddrive/file/download?pr=ucpro&fr=pc', {
        method: 'POST',
        cookie: this.cookie,
        body: { fids: [fid], pwd_id: sharePwdId(this.shareUrl), stoken: this.stoken },
      });
      this._assertOk(json, '获取下载直链');
      const first = (json.data ?? [])[0] ?? {};
      if (!first.download_url) throw new Error(`夸克未返回下载直链：${JSON.stringify(json).slice(0, 300)}`);
      source = {
        url: first.download_url,
        headers: {
          'user-agent': UA,
          referer: 'https://pan.quark.cn/',
          ...cookieHeader(this.cookie),
        },
      };
    }
    source.expiresAt = Date.now() + 30 * 60 * 1000;
    this._links.set(fid, source);
    return source;
  }

  /**
   * 通过 HTTP Range 远程读取 ZIP 的中央目录（不下载整个文件）。
   * @param {{ fid: string, size: number }} pack
   */
  async readCentralDirectory(pack) {
    const source = await this.downloadLink(pack.fid);
    let tailLen = 128 * 1024;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const start = Math.max(0, pack.size - tailLen);
      const { buffer, status } = await fetchRange(source, start, pack.size - 1);
      const base = status === 200 ? 0 : start;
      const tail = buffer;
      const eocd = findEocd(tail);
      if (eocd < 0) {
        tailLen *= 2;
        continue;
      }
      const totalEntries = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      const cdStart = base === 0 ? cdOffset : cdOffset - base;
      if (cdStart < 0 || cdStart + cdSize > tail.length) {
        tailLen *= 2;
        continue;
      }
      const entries = [];
      let ptr = cdStart;
      for (let i = 0; i < totalEntries; i += 1) {
        if (tail.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`ZIP 中央目录损坏（entry ${i}）`);
        const method = tail.readUInt16LE(ptr + 10);
        const compressedSize = tail.readUInt32LE(ptr + 20);
        const uncompressedSize = tail.readUInt32LE(ptr + 24);
        const nameLen = tail.readUInt16LE(ptr + 28);
        const extraLen = tail.readUInt16LE(ptr + 30);
        const commentLen = tail.readUInt16LE(ptr + 32);
        const localHeaderOffset = tail.readUInt32LE(ptr + 42);
        const name = tail.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
        ptr += 46 + nameLen + extraLen + commentLen;
      }
      return { entries, source };
    }
    throw new Error('无法定位 ZIP 中央目录（分享文件可能不是 ZIP）');
  }

  /** 远程读取 ZIP 中单个文件内容 */
  async readEntry(source, entry) {
    const { buffer } = await fetchRange(
      source,
      entry.localHeaderOffset,
      entry.localHeaderOffset + 30 + 1024 + entry.compressedSize - 1,
    );
    if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP 本地文件头损坏：${entry.name}`);
    const nameLen = buffer.readUInt16LE(26);
    const extraLen = buffer.readUInt16LE(28);
    const dataStart = 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
  }

  async _ensureStoken() {
    if (this.stoken) return;
    if (!this.cookie) throw new Error('direct 模式需要 QUARK_COOKIE（登录夸克网盘后的 Cookie）');
    const json = await quarkJson('/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc', {
      method: 'POST',
      cookie: this.cookie,
      body: { pwd_id: sharePwdId(this.shareUrl), passcode: this.sharePwd },
    });
    this._assertOk(json, '获取分享 stoken');
    this.stoken = json.data?.stoken;
    if (!this.stoken) throw new Error(`夸克未返回 stoken：${JSON.stringify(json).slice(0, 300)}`);
  }

  _assertOk(json, action) {
    if (json?.code !== 0 && json?.status !== 200) {
      throw new Error(`${action}失败（code=${json?.code ?? json?.status}）：${json?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
  }

  /** resolver 模式下，/v2/getFileList 返回的结果里带每个文件的 parserUrl（含 fid/stoken） */
  async _resolverListingUrl(fid) {
    const root = await this.listRoot();
    for (const item of root) {
      if (!item.folder) {
        if (item.fid === fid) return { param: item.parserUrl.split('/v2/redirectUrl/qk/')[1] };
        continue;
      }
      const children = await this.listDir(item.fid, item.parserUrl);
      const child = children.find((c) => c.fid === fid);
      if (child) return { param: child.parserUrl.split('/v2/redirectUrl/qk/')[1] };
    }
    throw new Error(`resolver 列表中找不到文件 ${fid}`);
  }

  async _resolverJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`解析服务返回非 JSON（${res.status}）：${text.slice(0, 200)}`);
    }
    if (json?.success === false) {
      throw new Error(`解析服务错误：${json?.msg ?? JSON.stringify(json).slice(0, 200)}`);
    }
    if (json?.code !== undefined && json?.code !== 200 && !json?.downloadUrl) {
      throw new Error(`解析服务错误：${json?.msg ?? JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
  }
}

/** HTTP Range 请求（带重试） */
export async function fetchRange(source, start, end) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(source.url, {
        headers: { ...source.headers, range: `bytes=${start}-${end}` },
      });
      if (res.status !== 200 && res.status !== 206) {
        const body = await res.text();
        throw new Error(`Range ${start}-${end} 失败：HTTP ${res.status} ${body.slice(0, 120)}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, status: res.status, contentRange: res.headers.get('content-range') };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
  }
  throw lastError;
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
