// Read what the smoke test needs from an APK without aapt2: the native ABIs (lib/<abi>/*.so) and the
// package name from the binary AndroidManifest.xml. An APK is a zip; this is a small reader of the zip
// central directory (stored and deflated entries) plus an Android binary XML (AXML) parser.
//
// Errors: a file that is missing or is not a zip throws EmuError("BAD_OPTION", ...) with a clear message.
// Anything unexpected inside a valid zip (no manifest, corrupt manifest, unsupported compression) gives
// null / an empty list instead of throwing.

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { EmuError } from "./errors.ts";

// ---------------------------------------------------------------------------------------------------
// Zip

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CDH_SIG = 0x02014b50;
const CDH_SIZE = 46;
const LFH_SIG = 0x04034b50;
const LFH_SIZE = 30;
/** Upper bound for an entry we inflate (the manifest is a few KB; this stops zip bombs). */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

function notZip(path: string, why: string): EmuError {
  return new EmuError("BAD_OPTION", `Not a zip/APK file: ${path} (${why}).`);
}

async function openApk(path: string): Promise<FileHandle> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new EmuError("BAD_OPTION", `APK not found: ${path}`);
    if (code === "EISDIR") throw notZip(path, "it is a directory");
    throw new EmuError("BAD_OPTION", `Cannot open the APK ${path} (${(err as Error).message}).`);
  }
  if ((await fh.stat()).isDirectory()) {
    await fh.close();
    throw notZip(path, "it is a directory");
  }
  return fh;
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** Lists the entries of the zip's central directory. Throws a clear BAD_OPTION error when it is not a zip. */
async function readCentralDirectory(fh: FileHandle, path: string): Promise<ZipEntry[]> {
  const { size: fileSize } = await fh.stat();
  if (fileSize < EOCD_MIN) throw notZip(path, `only ${fileSize} bytes`);

  // The end-of-central-directory record sits at the end, followed by a comment of at most 64 KB.
  const tailLen = Math.min(fileSize, EOCD_MIN + EOCD_MAX_COMMENT);
  const tailStart = fileSize - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);
  // Prefer a record whose comment length fits the file; fall back to the last signature (trailing bytes).
  let eocd = -1;
  let loose = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    if (loose < 0) loose = i;
    if (i + EOCD_MIN + tail.readUInt16LE(i + 20) <= tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) eocd = loose;
  if (eocd < 0) throw notZip(path, "no end of central directory record");

  const entryCount = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const zip64Locator = eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG;
  if (zip64Locator || entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw notZip(path, "ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > tailStart + eocd) throw notZip(path, "the central directory lies outside the file");

  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < entryCount; i++) {
    if (p + CDH_SIZE > cd.length || cd.readUInt32LE(p) !== CDH_SIG) {
      throw notZip(path, `central directory entry ${i} is damaged`);
    }
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const end = p + CDH_SIZE + nameLen + extraLen + commentLen;
    if (end > cd.length) throw notZip(path, `central directory entry ${i} is damaged`);
    // Bit 11 = UTF-8 name; otherwise CP437, which equals ASCII for the names an APK uses.
    const nameBytes = cd.subarray(p + CDH_SIZE, p + CDH_SIZE + nameLen);
    const name = flags & 0x800 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
    entries.push({ name, method, flags, compressedSize, size, localHeaderOffset });
    p = end;
  }
  return entries;
}

/** The uncompressed bytes of one entry, or null when it cannot be read (encrypted, unknown method, damaged). */
async function readEntry(fh: FileHandle, entry: ZipEntry): Promise<Buffer | null> {
  if (entry.flags & 0x1) return null; // encrypted
  if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) return null;
  const lfh = await readAt(fh, entry.localHeaderOffset, LFH_SIZE);
  if (lfh.length < LFH_SIZE || lfh.readUInt32LE(0) !== LFH_SIG) return null;
  const dataStart = entry.localHeaderOffset + LFH_SIZE + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  const data = await readAt(fh, dataStart, entry.compressedSize);
  if (data.length < entry.compressedSize) return null;
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// ABIs

const ABI_ENTRY = /^lib\/([^/]+)\/[^/]+\.so$/;

/** Sorted unique <abi> of lib/<abi>/*.so entries (same rule as PS Get-ApkAbis). */
export function abisFromEntryNames(names: Iterable<string>): string[] {
  const abis = new Set<string>();
  for (const n of names) {
    const m = ABI_ENTRY.exec(n);
    if (m) abis.add(m[1]);
  }
  return [...abis].sort();
}

// ---------------------------------------------------------------------------------------------------
// Android binary XML (AXML)

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x100;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;

interface StringPool {
  get(index: number): string | null;
}

function readStringPool(buf: Buffer, start: number, chunkSize: number, headerSize: number): StringPool | null {
  if (headerSize < 28 || start + 28 > buf.length) return null;
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const end = start + chunkSize;
  const offsets = start + headerSize;
  if (offsets + count * 4 > end || start + stringsStart > end) return null;
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const cache = new Map<number, string | null>();

  const decode = (index: number): string | null => {
    let p = start + stringsStart + buf.readUInt32LE(offsets + index * 4);
    if (p >= end) return null;
    if (utf8) {
      // Length in UTF-16 units (skipped), then length in bytes; each 1 byte, or 2 when the high bit is set.
      const skipLen = (): number => {
        if (p >= end) return -1;
        let n = buf[p++];
        if (n & 0x80) {
          if (p >= end) return -1;
          n = ((n & 0x7f) << 8) | buf[p++];
        }
        return n;
      };
      if (skipLen() < 0) return null;
      const byteLen = skipLen();
      if (byteLen < 0 || p + byteLen > end) return null;
      return buf.toString("utf8", p, p + byteLen);
    }
    // UTF-16LE: length in units; 2 units when the high bit is set.
    if (p + 2 > end) return null;
    let n = buf.readUInt16LE(p);
    p += 2;
    if (n & 0x8000) {
      if (p + 2 > end) return null;
      n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p);
      p += 2;
    }
    if (p + n * 2 > end) return null;
    return buf.toString("utf16le", p, p + n * 2);
  };

  return {
    get(index: number): string | null {
      if (index < 0 || index >= count) return null;
      if (!cache.has(index)) cache.set(index, decode(index));
      return cache.get(index) ?? null;
    },
  };
}

/**
 * The `package` attribute of the first <manifest> element of a binary AndroidManifest.xml.
 * null for anything unexpected (not AXML, truncated, no manifest element, no package attribute).
 */
export function parseManifestPackage(buf: Buffer): string | null {
  try {
    if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) return null;
    const fileHeaderSize = buf.readUInt16LE(2);
    const total = buf.readUInt32LE(4);
    if (total > buf.length || fileHeaderSize < 8) return null; // truncated
    let pool: StringPool | null = null;
    let p = fileHeaderSize;
    while (p + 8 <= total) {
      const type = buf.readUInt16LE(p);
      const headerSize = buf.readUInt16LE(p + 2);
      const size = buf.readUInt32LE(p + 4);
      if (size < 8 || headerSize < 8 || headerSize > size || p + size > total) return null;
      if (type === RES_STRING_POOL_TYPE && !pool) {
        pool = readStringPool(buf, p, size, headerSize);
        if (!pool) return null;
      } else if (type === RES_XML_START_ELEMENT_TYPE) {
        if (!pool) return null;
        const ext = p + headerSize;
        if (ext + 20 > p + size) return null;
        const name = pool.get(buf.readUInt32LE(ext + 4));
        if (name === "manifest") {
          const attrStart = buf.readUInt16LE(ext + 8);
          const attrSize = buf.readUInt16LE(ext + 10);
          const attrCount = buf.readUInt16LE(ext + 12);
          if (attrSize < 20) return null;
          for (let i = 0; i < attrCount; i++) {
            const a = ext + attrStart + i * attrSize;
            if (a + 20 > p + size) return null;
            if (pool.get(buf.readUInt32LE(a + 4)) !== "package") continue;
            const raw = buf.readUInt32LE(a + 8);
            if (raw !== NO_INDEX) return pool.get(raw);
            const dataType = buf.readUInt8(a + 15);
            return dataType === TYPE_STRING ? pool.get(buf.readUInt32LE(a + 16)) : null;
          }
          return null;
        }
      }
      p += size;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Public API

/** Package name and native ABIs of an APK, reading the file once. */
export async function readApkInfo(path: string): Promise<{ package: string | null; abis: string[] }> {
  const fh = await openApk(path);
  try {
    const entries = await readCentralDirectory(fh, path);
    const abis = abisFromEntryNames(entries.map((e) => e.name));
    const manifest = entries.find((e) => e.name === "AndroidManifest.xml");
    const bytes = manifest ? await readEntry(fh, manifest) : null;
    return { package: bytes ? parseManifestPackage(bytes) : null, abis };
  } finally {
    await fh.close();
  }
}

/** Sorted unique <abi> of lib/<abi>/*.so; empty when the APK has no native code. */
export async function apkAbis(path: string): Promise<string[]> {
  const fh = await openApk(path);
  try {
    return abisFromEntryNames((await readCentralDirectory(fh, path)).map((e) => e.name));
  } finally {
    await fh.close();
  }
}

/** <manifest package=...> from the binary AndroidManifest.xml; null when it cannot be read. */
export async function apkPackage(path: string): Promise<string | null> {
  return (await readApkInfo(path)).package;
}
