/**
 * 曲目目录构建：把 mai-charts 的数据（music_data.json / music_alias.json / .adx 包）
 * 转换成预览前端使用的 LxnsSong 兼容格式。
 */
import path from 'node:path';

/** 归一化曲名：全角/半角、大小写、空白、常见标点差异 */
export function normalizeTitle(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~、。·・「」『』（）［］｛｝〈〉《》【】…‥〜～ー－―—–‐'’"“”]/g, '');
}

/** Levenshtein 编辑距离（带上界提前退出） */
export function editDistance(a, b, maxDistance = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * 解析 maidata.txt 的元信息（不解析 note 正文，正文交给前端 ChartParser）。
 * @param {string} text
 */
export function parseMaidataMeta(text) {
  /** @type {{ title?: string, artist?: string, bpm?: number, levels: Record<number, string>, designers: Record<number, string>, inotes: number[] }} */
  const meta = { levels: {}, designers: {}, inotes: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('&')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(1, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'title') meta.title = value;
    else if (key === 'artist') meta.artist = value;
    else if (key === 'wholebpm') meta.bpm = Number(value) || undefined;
    let matched = /^lv_([1-6])$/.exec(key);
    if (matched) {
      meta.levels[Number(matched[1])] = value;
      continue;
    }
    matched = /^des_([1-6])$/.exec(key);
    if (matched) {
      meta.designers[Number(matched[1])] = value;
      continue;
    }
    matched = /^inote_([1-6])$/.exec(key);
    if (matched) meta.inotes.push(Number(matched[1]));
  }
  return meta;
}

/** 解析 API 的 levelLabel，例如 `标准 · MASTER 13` → `13` */
export function parseLevelLabel(levelLabel) {
  if (!levelLabel) return null;
  const matched = /(\d+\+?)\s*$/.exec(String(levelLabel).trim());
  return matched ? matched[1] : null;
}

/**
 * 把 .adx 文件列表转换成可匹配的条目。
 * 命名规则：标准谱 `曲名.adx`；同曲有 DX 谱时 DX 为 `曲名 [DX].adx`。
 * @param {{ path: string, sha: string, size: number }[]} adxList
 */
export function buildAdxEntries(adxList) {
  return adxList.map((item) => {
    const fileName = path.posix.basename(item.path, '.adx');
    const dxSuffix = / \[DX\]$/.test(fileName);
    const title = dxSuffix ? fileName.replace(/ \[DX\]$/, '') : fileName;
    return {
      ...item,
      fileName,
      title,
      dxSuffix,
      normTitle: normalizeTitle(title),
    };
  });
}

/**
 * 将 music_data 中的曲目（song + type）与 .adx 包做匹配。
 *
 * 规则：
 *  1. 先按归一化曲名精确匹配；
 *  2. 失败时按编辑距离模糊匹配（同曲名多语言写法 / 标点差异 / 空格差异）；
 *  3. 类型判定：有 `[DX]` 后缀的包必为 DX；无后缀的包默认属于 SD，
 *     但若该曲名在目录里只有 DX 条目，则视为 DX（站点对只存在 DX 的曲目不加后缀）。
 *
 * @param {any[]} musicData mai-charts data/music_data.json
 * @param {ReturnType<typeof buildAdxEntries>} adxEntries
 */
export function matchAdxToSongs(musicData, adxEntries) {
  /** @type {Map<string, ReturnType<typeof buildAdxEntries>>} */
  const byTitle = new Map();
  for (const entry of adxEntries) {
    const list = byTitle.get(entry.title) ?? [];
    list.push(entry);
    byTitle.set(entry.title, list);
  }

  const songsByTitle = new Map();
  for (const song of musicData) {
    const list = songsByTitle.get(song.title) ?? [];
    list.push(song);
    songsByTitle.set(song.title, list);
  }

  /** @type {Map<string, { entry: any, score: number }>} key = `${songId}:${type}` */
  const mapping = new Map();
  const claimed = new Set();
  const songMatches = [];

  const assign = (song, entry, score) => {
    mapping.set(`${song.id}:${song.type}`, { entry, score });
    claimed.add(entry.path);
    songMatches.push({ songId: song.id, type: song.type, adx: entry.path, title: song.title, score });
  };

  // 第一轮：同曲名精确匹配，按 SD 取无后缀、DX 取 [DX] 的规则分配
  for (const [title, songs] of songsByTitle) {
    const entries = byTitle.get(title) ?? [];
    if (entries.length === 0) continue;
    const plain = entries.filter((e) => !e.dxSuffix);
    const dxOnly = entries.filter((e) => e.dxSuffix);
    const sdSongs = songs.filter((s) => s.type === 'SD');
    const dxSongs = songs.filter((s) => s.type === 'DX');

    if (sdSongs.length > 0) {
      if (plain.length > 0) assign(sdSongs[0], plain.shift(), 1);
    }

    if (dxSongs.length > 0) {
      if (dxOnly.length > 0) assign(dxSongs[0], dxOnly.shift(), 1);
      else if (plain.length > 0 && sdSongs.length === 0) assign(dxSongs[0], plain.shift(), 1);
      else if (plain.length > 0) {
        // 同名 SD/DX 都存在，但仓库只有无后缀包：
        // 无后缀包按站点规则属于 SD，DX 缺失；此时只有 SD 不存在时才把包给 DX
        if (sdSongs.length === 0) assign(dxSongs[0], plain.shift(), 1);
      }
    }
  }

  // 第二轮：模糊匹配（仅处理仍未匹配的曲目）
  const remainingSongs = musicData.filter((s) => !mapping.has(`${s.id}:${s.type}`));
  /** @type {Map<string, any[]>} */
  const freeByNorm = new Map();
  for (const entry of adxEntries) {
    if (claimed.has(entry.path)) continue;
    const list = freeByNorm.get(entry.normTitle) ?? [];
    list.push(entry);
    freeByNorm.set(entry.normTitle, list);
  }

  for (const song of remainingSongs) {
    const norm = normalizeTitle(song.title);
    let best = null;
    let bestScore = 0;
    for (const [candidateNorm, entries] of freeByNorm) {
      const maxLen = Math.max(norm.length, candidateNorm.length);
      if (maxLen === 0) continue;
      const maxDistance = Math.max(1, Math.floor(maxLen * 0.18));
      const distance = editDistance(norm, candidateNorm, maxDistance);
      if (distance > maxDistance) continue;
      const score = 1 - distance / maxLen;
      if (score < 0.82 || score <= bestScore) continue;
      // 类型偏好：DX 优先 [DX] 后缀的包；SD 优先无后缀
      const preferred = entries.find((e) => (song.type === 'DX' ? e.dxSuffix : !e.dxSuffix)) ?? entries[0];
      best = preferred;
      bestScore = score;
    }
    if (best) {
      assign(song, best, bestScore);
      const list = freeByNorm.get(best.normTitle);
      if (list) {
        const index = list.indexOf(best);
        if (index >= 0) list.splice(index, 1);
      }
    }
  }

  const unmatchedSongs = musicData
    .filter((s) => !mapping.has(`${s.id}:${s.type}`))
    .map((s) => ({ id: s.id, title: s.title, type: s.type }));
  const matchedPaths = new Set([...mapping.values()].map((m) => m.entry.path));
  const unmatchedAdx = adxEntries.filter((e) => !matchedPaths.has(e.path)).map((e) => e.path);

  return { mapping, songMatches, unmatchedSongs, unmatchedAdx };
}

/**
 * 生成前端目录（LxnsSong 兼容格式）。
 *
 * music_data 中标准谱与 DX 谱是两条独立记录（DX 记录 id = 落雪曲目 id + 10000），
 * 这里按落雪基础 id 合并成一首曲目，`difficulties.standard` / `difficulties.dx` 分别填充。
 *
 * @param {{
 *   musicData: any[],
 *   aliasList: { SongID: number, Alias: string[] }[],
 *   matching: ReturnType<typeof matchAdxToSongs>,
 *   maidataMetaByChartFileId: Map<number, { title?: string, artist?: string, bpm?: number, levels?: Record<number,string>, designers?: Record<number,string> }>,
 *   apiLevelByChartKey?: Map<string, string>,
 * }} input
 */
export function buildCatalog(input) {
  const { musicData, aliasList, matching, maidataMetaByChartFileId, apiLevelByChartKey } = input;

  /** @type {Map<string, number>} */
  const versionCodeByTitle = new Map();
  const versionEntries = [];
  /** @type {Map<string, number>} */
  const genreCodeByName = new Map();
  const genreEntries = [];

  const versionCodeFor = (title) => {
    const key = title || '未知版本';
    if (!versionCodeByTitle.has(key)) {
      const code = versionCodeByTitle.size + 1;
      versionCodeByTitle.set(key, code);
      versionEntries.push({ id: code, title: key, version: code });
    }
    return versionCodeByTitle.get(key);
  };

  // 按落雪基础 id 合并 SD / DX 记录
  /** @type {Map<number, { standard?: any, dx?: any }>} */
  const groups = new Map();
  for (const song of musicData) {
    const rawId = Number(song.id);
    if (!Number.isFinite(rawId)) continue;
    const kind = song.type === 'DX' ? 'dx' : 'standard';
    const baseId = rawId >= 10000 ? rawId - 10000 : rawId;
    const group = groups.get(baseId) ?? {};
    group[kind] = song;
    groups.set(baseId, group);
  }

  const songs = [];
  const aliases = [];

  for (const [baseId, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const primary = group.standard ?? group.dx;
    if (!primary) continue;

    /** @type {Record<'standard'|'dx', any[]>} */
    const difficulties = { standard: [], dx: [] };

    for (const kind of /** @type {const} */ (['standard', 'dx'])) {
      const entry = group[kind];
      if (!entry) continue;
      const type = kind === 'dx' ? 'DX' : 'SD';
      if (!matching.mapping.has(`${entry.id}:${type}`)) continue;

      const chartFileId = kind === 'dx' ? baseId + 10000 : baseId;
      const meta = maidataMetaByChartFileId.get(chartFileId) ?? {};
      const basic = entry.basic_info ?? {};
      const versionCode = versionCodeFor(basic.from || '');
      const levels = Array.isArray(entry.level) ? entry.level : [];
      const ds = Array.isArray(entry.ds) ? entry.ds : [];
      const charts = Array.isArray(entry.charts) ? entry.charts : [];

      for (let difficulty = 0; difficulty < 5; difficulty += 1) {
        const inoteIndex = difficulty + 2; // inote_2 = BASIC ... inote_6 = Re:MASTER
        const apiLevel = apiLevelByChartKey?.get(`${baseId}:${kind}:${inoteIndex}`);
        const maidataLevel = meta.levels?.[inoteIndex];
        // 优先 API（落雪数据源通常更新更及时），其次 .adx 内等级，最后 music_data
        const level = apiLevel || maidataLevel || levels[difficulty] || '';
        if (!level) continue;
        const levelText = String(level).trim();
        if (levelText === '0' || levelText === '-') continue;

        difficulties[kind].push({
          type: kind,
          difficulty,
          level: levelText,
          level_value: Number(ds[difficulty]) || 0,
          note_designer: meta.designers?.[inoteIndex] || charts[difficulty]?.charter || '',
          version: versionCode,
        });
      }
    }

    if (difficulties.standard.length === 0 && difficulties.dx.length === 0) continue;

    // 曲名/艺术家/BPM 优先取标准谱 maidata（DX 包的 &title 可能带 " [DX]" 后缀）
    const sdMeta = group.standard ? maidataMetaByChartFileId.get(baseId) : undefined;
    const dxMeta = group.dx ? maidataMetaByChartFileId.get(baseId + 10000) : undefined;
    const cleanTitle = (title) => (title ? String(title).replace(/\s*\[(?:DX|SD)\]$/, '') : title);
    const primaryMeta = {
      title: cleanTitle(sdMeta?.title) || cleanTitle(dxMeta?.title),
      artist: sdMeta?.artist || dxMeta?.artist,
      bpm: sdMeta?.bpm || dxMeta?.bpm,
    };
    const basicInfo = primary.basic_info ?? {};
    const genreName = basicInfo.genre || '';
    if (genreName && !genreCodeByName.has(genreName)) {
      const code = genreCodeByName.size + 1;
      genreCodeByName.set(genreName, code);
      genreEntries.push({ id: code, title: genreName, genre: genreName });
    }

    songs.push({
      id: baseId,
      title: primaryMeta.title || primary.title,
      artist: primaryMeta.artist || basicInfo.artist || '',
      genre: genreName,
      bpm: Number(primaryMeta.bpm) || Number(basicInfo.bpm) || 0,
      version: Number(difficulties.standard[0]?.version ?? difficulties.dx[0]?.version ?? 1),
      difficulties: {
        standard: difficulties.standard,
        dx: difficulties.dx,
      },
      map: null,
      rights: null,
      locked: false,
      disabled: false,
    });

    const songAlias = aliasList.find((item) => Number(item.SongID) === baseId);
    if (songAlias?.Alias?.length) {
      aliases.push({ song_id: baseId, aliases: [...new Set(songAlias.Alias)] });
    }
  }

  songs.sort((a, b) => a.id - b.id);

  return {
    catalog: { songs, genres: genreEntries, versions: versionEntries },
    aliases: { aliases },
    versionTitleByCode: Object.fromEntries(versionEntries.map((v) => [v.version, v.title])),
  };
}
