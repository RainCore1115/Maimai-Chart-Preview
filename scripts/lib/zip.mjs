/**
 * 极简 ZIP 读取器（仅依赖 Node 内置 zlib）
 *
 * mai-charts 的 `.adx` 包本质是 ZIP，包内含 `maidata.txt`、`track.mp3`、`bg.jpg` 等。
 * 这里只需要读出 `maidata.txt`，因此实现「中央目录 → 本地文件头 → inflateRaw」的最小路径。
 */
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/**
 * @typedef {{ name: string, compressionMethod: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number }} ZipEntry
 */

/**
 * 列出 ZIP 内所有文件（只读中央目录，不解析内容）。
 * @param {Buffer} buffer
 * @returns {ZipEntry[]}
 */
export function listZipEntries(buffer) {
  const eocdOffset = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  /** @type {ZipEntry[]} */
  const entries = [];
  let ptr = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > buffer.length || buffer.readUInt32LE(ptr) !== SIG_CEN) {
      throw new Error('ZIP 中央目录损坏');
    }
    const compressionMethod = buffer.readUInt16LE(ptr + 10);
    let compressedSize = buffer.readUInt32LE(ptr + 20);
    let uncompressedSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    let localHeaderOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      // 解析 ZIP64 扩展字段（id = 0x0001）
      const extraStart = ptr + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      for (let p = extraStart; p + 4 <= extraEnd; ) {
        const id = buffer.readUInt16LE(p);
        const size = buffer.readUInt16LE(p + 2);
        if (id === 0x0001) {
          let q = p + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
        }
        p += 4 + size;
      }
    }

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 读取 ZIP 内单个文件内容。
 * @param {Buffer} buffer
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
export function readZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== SIG_LOC) throw new Error(`ZIP 本地文件头损坏：${entry.name}`);
  const nameLen = buffer.readUInt16LE(offset + 26);
  const extraLen = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return Buffer.from(data);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的 ZIP 压缩方式 ${entry.compressionMethod}：${entry.name}`);
}

/**
 * 从 .adx（ZIP）内容中取出 maidata.txt 文本。
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractMaidata(buffer) {
  const entries = listZipEntries(buffer);
  const entry = entries.find((e) => e.name === 'maidata.txt' || e.name.endsWith('/maidata.txt'));
  if (!entry) throw new Error('adx 包内未找到 maidata.txt');
  return readZipEntry(buffer, entry).toString('utf8');
}

/** @param {Buffer} buffer */
function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
}
