/**
 * mai-charts 仓库数据源
 *
 * 支持两种模式：
 *  - local：本地已有仓库（git clone / sparse checkout），直接读取文件；
 *  - git：通过 partial clone（--filter=blob:none）+ `git cat-file blob` 按需懒加载，
 *         适合 GitHub Actions 等 CI 环境，无需把 500MB 的 .adx 全量拉下来。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_REPO = 'https://cnb.cool/project-baka86/mai-charts.git';
/** 上游公共仓库：fork 元数据损坏（raw 全 404、缺 data/music_data.json）时的兜底数据源 */
export const FALLBACK_REPO = 'https://cnb.cool/sulieripple/mai-charts.git';

/** 去掉 URL 里的凭据，得到匿名可访问的 https 地址 */
export function stripCredentials(url) {
  return url.replace(/^https?:\/\/[^@/]+@/, 'https://');
}

/** 把仓库 slug（`org/repo`）或完整 URL 规范化成 git URL，并带上 CNB token（如有）。 */
export function resolveRepoUrl(repo = process.env.CNB_REPO_URL ?? DEFAULT_REPO, token = process.env.CNB_TOKEN) {
  if (/^https?:\/\//.test(repo)) return repo;
  if (/^git@/.test(repo)) return repo;
  const base = `https://cnb.cool/${repo.replace(/^\/+|\/+$/g, '')}.git`;
  if (!token) return base;
  const username = process.env.CNB_TOKEN_USER_NAME ?? 'cnb';
  return base.replace('https://', `https://${username}:${token}@`);
}

export class GitRepoSource {
  /** @param {{ workDir: string, ref?: string, repo?: string, token?: string }} options */
  constructor(options) {
    this.workDir = options.workDir;
    this.ref = options.ref ?? 'main';
    this.url = resolveRepoUrl(options.repo, options.token);
    this.maxBuffer = 256 * 1024 * 1024;
    this.treeCache = null;
  }

  async git(args, options = {}) {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: this.workDir,
      maxBuffer: this.maxBuffer,
      encoding: options.encoding ?? 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }

  /** 确保本地存在 partial clone，并更新到指定分支最新提交。 */
  async ensureClone() {
    if (!fs.existsSync(path.join(this.workDir, '.git'))) {
      fs.mkdirSync(path.dirname(this.workDir), { recursive: true });
      try {
        await execFileAsync(
          'git',
          ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', this.ref, this.url, this.workDir],
          { maxBuffer: this.maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
        );
      } catch (error) {
        // 带凭据的地址失败（token 过期等）时改用匿名地址重试
        const anonUrl = stripCredentials(this.url);
        if (anonUrl === this.url) throw error;
        await execFileAsync(
          'git',
          ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', this.ref, anonUrl, this.workDir],
          { maxBuffer: this.maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
        );
        this.url = anonUrl;
      }
      return;
    }
    // 已存在：拉取最新提交（partial clone 只更新 tree）
    try {
      await this.git(['fetch', '--depth', '1', 'origin', this.ref]);
    } catch (error) {
      const anonUrl = stripCredentials(this.url);
      if (anonUrl === this.url) throw error;
      await this.git(['remote', 'set-url', 'origin', anonUrl]);
      this.url = anonUrl;
      await this.git(['fetch', '--depth', '1', 'origin', this.ref]);
    }
    await this.git(['update-ref', `refs/remotes/origin/${this.ref}`, 'FETCH_HEAD']);
  }

  /** 列出仓库内全部文件（path → blob sha + size）。 */
  async tree() {
    if (this.treeCache) return this.treeCache;
    const remoteRef = `refs/remotes/origin/${this.ref}`;
    const out = await this.git(['ls-tree', '-r', remoteRef]);
    /** @type {Map<string, { sha: string, size: number }>} */
    const map = new Map();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [meta, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      const fields = meta.trim().split(/\s+/);
      // <mode> <type> <sha> <path>
      const sha = fields[2];
      map.set(filePath, { sha, size: 0 });
    }
    this.treeCache = map;
    return map;
  }

  /** 读取某个 blob（懒加载：首次会从远端拉取该 blob）。 */
  async readBlob(sha) {
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', sha], {
      cwd: this.workDir,
      maxBuffer: this.maxBuffer,
      encoding: 'buffer',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (!Buffer.isBuffer(stdout)) return Buffer.from(stdout);
    return stdout;
  }

  /** 按路径读取文本文件。 */
  async readTextFile(filePath) {
    const tree = await this.tree();
    const entry = tree.get(filePath);
    if (!entry) return null;
    const buf = await this.readBlob(entry.sha);
    return buf.toString('utf8');
  }

  /** 列出 charts/ 下的 .adx 包。 */
  async listAdx() {
    const tree = await this.tree();
    const out = [];
    for (const [filePath, info] of tree) {
      if (filePath.startsWith('charts/') && filePath.endsWith('.adx')) {
        out.push({ path: filePath, sha: info.sha, size: info.size });
      }
    }
    return out;
  }

  /** 批量把 charts/ 和 data/ 检出到本地（一次性全量拉取，适合本地/首次构建）。 */
  async checkoutCharts() {
    await this.git(['sparse-checkout', 'init', '--cone']);
    await this.git(['sparse-checkout', 'set', 'charts', 'data']);
    await this.git(['checkout', this.ref]);
  }
}

/** 直接从本地已检出的 mai-charts 目录读取（无需 git 命令）。 */
export class LocalDirSource {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async listAdx() {
    const dir = path.join(this.rootDir, 'charts');
    if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.adx'))
      .map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return { path: `charts/${name}`, sha: `local:${stat.size}:${stat.mtimeMs}`, size: stat.size };
      });
  }

  readBlobByPath(filePath) {
    return fs.promises.readFile(path.join(this.rootDir, filePath));
  }

  async readTextFile(filePath) {
    const full = path.join(this.rootDir, filePath);
    if (!fs.existsSync(full)) return null;
    return fs.promises.readFile(full, 'utf8');
  }
}

/**
 * 通过 CNB OpenAPI 直接读取仓库文件（不做全量 clone）。
 *
 * 列表：partial clone 只取 tree（几百 KB），拿到 charts/*.adx 路径；
 * 读取：`GET https://api.cnb.cool/{repo}/-/git/raw/{ref}/{path}`（需要 CNB_TOKEN 访问鉴权）。
 * 适合 CI / 首次构建：只下载需要解析的 .adx，不落盘保存整包。
 */
export class RemoteRawSource {
  /** @param {{ workDir: string, ref?: string, repo?: string, token?: string }} options */
  constructor(options) {
    this.workDir = options.workDir;
    this.ref = options.ref ?? 'main';
    this.repoSlug = normalizeRepoSlug(options.repo);
    this.token = options.token ?? process.env.CNB_TOKEN ?? '';
    this.gitUrl = resolveRepoUrl(options.repo, this.token);
    this.treeSource = new GitRepoSource({
      workDir: options.workDir,
      ref: this.ref,
      repo: options.repo,
      token: this.token,
    });
    this.rawBase = `https://api.cnb.cool/${this.repoSlug}/-/git/raw/${this.ref}`;
    this.anonRawBase = `https://cnb.cool/${this.repoSlug}/-/git/raw/${this.ref}`;
    this.requestCount = 0;
  }

  async ensureClone() {
    await this.treeSource.ensureClone();
  }

  /** @returns {Promise<{path: string, sha: string, size: number}[]>} */
  async listAdx() {
    const remoteRef = `refs/remotes/origin/${this.ref}`;
    const out = await this.treeSource.git(['ls-tree', '-r', remoteRef]);
    const entries = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [meta, ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (!filePath.startsWith('charts/') || !filePath.endsWith('.adx')) continue;
      const fields = meta.trim().split(/\s+/);
      entries.push({ path: filePath, sha: fields[2] ?? filePath, size: 0 });
    }
    return entries;
  }

  /** @param {string} filePath */
  async fetchRaw(filePath) {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    // CNB_TOKEN 失效时 api.cnb.cool 会 401；公共仓库改用 cnb.cool 匿名 raw 兜底
    const candidates = [`${this.rawBase}/${encodedPath}`];
    if (this.anonRawBase) candidates.push(`${this.anonRawBase}/${encodedPath}`);
    let lastError;
    let url = candidates[0];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt === 3 && candidates.length > 1) url = candidates[1];
      this.requestCount += 1;
      try {
        const res = await fetch(url, {
          headers: url === candidates[0] && this.token ? { Authorization: `Bearer ${this.token}` } : {},
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 401 || res.status === 400) {
          lastError = new Error(`HTTP ${res.status} ${filePath}`);
          if (candidates.length > 1 && url === candidates[0]) {
            url = candidates[1];
            continue;
          }
        }
        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status} ${filePath}`);
          await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${filePath}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** @param {string} filePath */
  readBlobByPath(filePath) {
    return this.fetchRaw(filePath);
  }

  /** @param {string} filePath */
  async readTextFile(filePath) {
    try {
      return (await this.fetchRaw(filePath)).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** `org/repo` 形式 */
export function normalizeRepoSlug(repo = DEFAULT_REPO) {
  if (/^https?:\/\//.test(repo)) {
    const cleaned = repo.replace(/^https?:\/\//, '').replace(/\.git$/, '');
    const afterHost = cleaned.slice(cleaned.indexOf('/') + 1);
    return afterHost.includes('@') ? afterHost.split('@').pop() : afterHost;
  }
  return repo.replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
}
