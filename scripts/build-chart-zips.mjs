/**
 * 生成谱面打包下载：按难度分类的 zip + 全部谱面合并包。
 *
 * 输出到 public/data/downloads/：
 *   charts-diff-2.zip … charts-diff-6.zip   仅指定难度、仅该谱面的 maidata（难度键重编号为 1）
 *   charts-all.zip                          全部曲目全部难度的完整 maidata（一曲一文件）
 *   manifest.json                           包清单（数量、字节数、sha256、生成时间）
 *
 * 输入：
 *   public/data/chart-index.json   由同步脚本产出（chartFileId / songId / kind / difficulty / title）
 *   public/data/simai/<fileId>.txt 对应谱面文本
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(DATA, 'downloads');
const SIMAI = path.join(DATA, 'simai');

const DIFF_NAMES = { 2: 'BASIC', 3: 'ADVANCED', 4: 'EXPERT', 5: 'MASTER', 6: 'RE:MASTER' };
//: 与单谱下载接口一致：这些全局键始终保留
const GLOBAL_KEYS = new Set(['title', 'artist', 'wholebpm', 'cabinet', 'genre', 'shortid', 'version', 'chartconverter']);
const README = [
  'maimai DX 谱面打包（预览站导出）',
  '',
  '谱面数据来自 mai-charts（CNB）与 AWMC chart-preview API，宴谱来自落雪查分器。',
  '文件为 maidata 格式文本，文件名格式：<曲名> [DX|ST] [难度].maidata.txt',
  '难度编号：2=BASIC 3=ADVANCED 4=EXPERT 5=MASTER 6=RE:MASTER',
  '',
  `生成时间：${new Date().toISOString()}`,
  '站点：https://preview.baka86.love',
  '',
].join('\n');

function safeName(title, kind, diff) {
  const clean = String(title)
    .replace(/\s*\[(?:DX|ST|1P|2P)\]\s*$/gi, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return `${clean || 'chart'} [${kind}] [${DIFF_NAMES[diff]}].maidata.txt`;
}

/** 只保留指定难度的键，并把难度下标重编号为 1 */
function filterDifficulty(text, diff) {
  const out = [];
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const matched = /^&([a-z]+)_(\d+)=(.*)$/i.exec(line);
    if (matched) {
      const key = matched[1].toLowerCase();
      const index = Number(matched[2]);
      if (index === diff) {
        section = key;
        out.push(`&${key}_1=${matched[3]}`);
      } else {
        section = null;
      }
      continue;
    }
    if (line.startsWith('&')) {
      const key = /^&([a-z]+)/i.exec(line)?.[1]?.toLowerCase();
      section = key ?? null;
      if (key && GLOBAL_KEYS.has(key)) out.push(line);
      continue;
    }
    if (section === 'inote') out.push(line);
  }
  return `${out.join('\n')}\n`;
}

function zipOf(files) {
  const tree = {};
  for (const [name, content] of files) tree[name] = new TextEncoder().encode(content);
  return Buffer.from(zipSync(tree, { level: 6, mtime: new Date() }));
}

async function main() {
  const index = JSON.parse(await readFile(path.join(DATA, 'chart-index.json'), 'utf8'));
  const existing = new Set((await readdir(SIMAI)).filter((name) => name.endsWith('.txt')).map((name) => name.replace(/\.txt$/, '')));
  const charts = Object.values(index.charts ?? {})
    .filter((chart) => chart && chart.chartFileId != null && DIFF_NAMES[chart.difficulty])
    .filter((chart) => existing.has(String(chart.chartFileId)))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'ja'));

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const manifest = { generatedAt: new Date().toISOString(), entries: charts.length, total: 0, packs: [] };
  const used = new Set();

  for (const diff of Object.keys(DIFF_NAMES).map(Number)) {
    const rows = charts.filter((chart) => chart.difficulty === diff);
    if (!rows.length) continue;
    const files = [['README.txt', README]];
    for (const chart of rows) {
      const text = await readFile(path.join(SIMAI, `${chart.chartFileId}.txt`), 'utf8');
      const kind = String(chart.kind || '').includes('dx') || Number(chart.chartFileId) >= 10000 ? 'DX' : 'ST';
      let name = safeName(chart.title, kind, diff);
      let n = 2;
      while (used.has(name)) name = safeName(chart.title, kind, diff).replace('.maidata.txt', ` (${n++}).maidata.txt`);
      used.add(name);
      files.push([name, filterDifficulty(text, diff)]);
    }
    const file = `charts-diff-${diff}.zip`;
    const buffer = zipOf(files);
    await writeFile(path.join(OUT, file), buffer);
    manifest.packs.push({
      kind: 'difficulty',
      difficulty: diff,
      name: DIFF_NAMES[diff],
      file,
      count: rows.length,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
  }

  // 全部谱面合并包：一曲一文件，保留全部难度
  const allFiles = [['README.txt', README]];
  const seen = new Set();
  for (const chart of charts) {
    const key = `${chart.chartFileId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = await readFile(path.join(SIMAI, `${chart.chartFileId}.txt`), 'utf8');
    const kind = String(chart.kind || '').includes('dx') || Number(chart.chartFileId) >= 10000 ? 'DX' : 'ST';
    const clean = String(chart.title).replace(/\s*\[(?:DX|ST|1P|2P)\]\s*$/gi, '').replace(/[\\/:*?"<>|]/g, '_').trim();
    allFiles.push([`${clean || chart.chartFileId} [${kind}].maidata.txt`, text]);
  }
  const allBuffer = zipOf(allFiles);
  await writeFile(path.join(OUT, 'charts-all.zip'), allBuffer);
  manifest.all = {
    kind: 'all',
    file: 'charts-all.zip',
    count: seen.size,
    bytes: allBuffer.length,
    sha256: createHash('sha256').update(allBuffer).digest('hex'),
  };
  manifest.total = seen.size;
  manifest.bytes = manifest.packs.reduce((sum, pack) => sum + pack.bytes, 0) + allBuffer.length;
  await writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`[zips] 曲目 ${seen.size} 首 / 难度条目 ${charts.length} 条 → ${manifest.packs.length} 个难度包 + 全部包 ${(allBuffer.length / 1024).toFixed(0)}KB`);
}

await main();
