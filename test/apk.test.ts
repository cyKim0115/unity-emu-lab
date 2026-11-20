// apk.ts: zip central directory reader, ABIs from lib/<abi>/*.so, package from a binary AndroidManifest.xml.
// Zips and AXML manifests are built here; the real sample APK is checked when it exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { apkAbis, apkPackage, readApkInfo, parseManifestPackage, abisFromEntryNames } from "../src/apk.ts";
import { isEmuError } from "../src/errors.ts";

// ---------------------------------------------------------------------------------------------------
// Zip builder

interface ZipInput {
  name: string;
  data: Buffer | string;
  method?: 0 | 8 | 12;
  /** Set the "data descriptor" flag and zero the sizes in the local header (as streaming writers do). */
  descriptor?: boolean;
}

function buildZip(inputs: ZipInput[], o: { comment?: string; trailing?: Buffer; prefix?: Buffer } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  if (o.prefix) {
    parts.push(o.prefix);
    offset += o.prefix.length;
  }
  for (const input of inputs) {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, "utf8");
    const method = input.method ?? 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(input.name, "utf8");
    const flags = 0x800 | (input.descriptor ? 0x8 : 0);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(input.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(input.descriptor ? 0 : body.length, 18);
    local.writeUInt32LE(input.descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = Buffer.from([0xfe, 0xca, 0x00, 0x00]); // a small extra field, like jar writers add
    local.writeUInt16LE(extra.length, 28);
    const pieces = [local, name, extra, body];
    if (input.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(data.length, 12);
      pieces.push(dd);
    }

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, name);

    for (const piece of pieces) {
      parts.push(piece);
      offset += piece.length;
    }
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(o.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(inputs.length, 8);
  eocd.writeUInt16LE(inputs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment, o.trailing ?? Buffer.alloc(0)]);
}

// ---------------------------------------------------------------------------------------------------
// AXML encoder (enough of the format for <manifest> and a child element)

type AttrValue = { raw: string } | { typedString: string } | { int: number };
interface XmlElement {
  name: string;
  attrs: { name: string; ns?: string; value: AttrValue }[];
  children?: XmlElement[];
}

const ANDROID_NS = "http://schemas.android.com/apk/res/android";

function chunk(type: number, header: Buffer, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(8 + header.length, 2);
  head.writeUInt32LE(8 + header.length + body.length, 4);
  return Buffer.concat([head, header, body]);
}

function encodeLen8(n: number): Buffer {
  return n > 0x7f ? Buffer.from([0x80 | (n >> 8), n & 0xff]) : Buffer.from([n]);
}

function encodeLen16(n: number): Buffer {
  const b = Buffer.alloc(n > 0x7fff ? 4 : 2);
  if (n > 0x7fff) {
    b.writeUInt16LE(0x8000 | (n >> 16), 0);
    b.writeUInt16LE(n & 0xffff, 2);
  } else b.writeUInt16LE(n, 0);
  return b;
}

function stringPool(strings: string[], utf8: boolean): Buffer {
  const datas = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, "utf8");
      return Buffer.concat([encodeLen8(s.length), encodeLen8(bytes.length), bytes, Buffer.from([0])]);
    }
    return Buffer.concat([encodeLen16(s.length), Buffer.from(s, "utf16le"), Buffer.alloc(2)]);
  });
  const offsets = Buffer.alloc(strings.length * 4);
  let off = 0;
  datas.forEach((d, i) => {
    offsets.writeUInt32LE(off, i * 4);
    off += d.length;
  });
  let data = Buffer.concat(datas);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(0, 4); // styles
  header.writeUInt32LE(utf8 ? 0x100 : 0, 8);
  header.writeUInt32LE(28 + offsets.length, 12); // stringsStart from chunk start
  header.writeUInt32LE(0, 16);
  return chunk(0x0001, header, Buffer.concat([offsets, data]));
}

function encodeAxml(root: XmlElement, o: { utf8: boolean; extraStrings?: string[] }): Buffer {
  const strings: string[] = [...(o.extraStrings ?? [])];
  const idx = (s: string): number => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  idx("android");
  idx(ANDROID_NS);

  const nodeHeader = (): Buffer => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(1, 0); // line
    h.writeUInt32LE(0xffffffff, 4); // comment
    return h;
  };
  const body: Buffer[] = [];
  const ns = Buffer.alloc(8);
  ns.writeUInt32LE(idx("android"), 0);
  ns.writeUInt32LE(idx(ANDROID_NS), 4);
  body.push(chunk(0x0100, nodeHeader(), ns));

  const emit = (el: XmlElement): void => {
    const ext = Buffer.alloc(20);
    ext.writeUInt32LE(0xffffffff, 0);
    ext.writeUInt32LE(idx(el.name), 4);
    ext.writeUInt16LE(20, 8);
    ext.writeUInt16LE(20, 10);
    ext.writeUInt16LE(el.attrs.length, 12);
    const attrs = el.attrs.map((a) => {
      const b = Buffer.alloc(20);
      b.writeUInt32LE(a.ns ? idx(a.ns) : 0xffffffff, 0);
      b.writeUInt32LE(idx(a.name), 4);
      b.writeUInt16LE(8, 12);
      if ("raw" in a.value) {
        const i = idx(a.value.raw);
        b.writeUInt32LE(i, 8);
        b.writeUInt8(0x03, 15);
        b.writeUInt32LE(i, 16);
      } else if ("typedString" in a.value) {
        b.writeUInt32LE(0xffffffff, 8);
        b.writeUInt8(0x03, 15);
        b.writeUInt32LE(idx(a.value.typedString), 16);
      } else {
        b.writeUInt32LE(0xffffffff, 8);
        b.writeUInt8(0x10, 15);
        b.writeInt32LE(a.value.int, 16);
      }
      return b;
    });
    body.push(chunk(0x0102, nodeHeader(), Buffer.concat([ext, ...attrs])));
    for (const c of el.children ?? []) emit(c);
    const end = Buffer.alloc(8);
    end.writeUInt32LE(0xffffffff, 0);
    end.writeUInt32LE(idx(el.name), 4);
    body.push(chunk(0x0103, nodeHeader(), end));
  };
  emit(root);
  body.push(chunk(0x0101, nodeHeader(), ns));

  // Resource map (ids for android:* attributes) like aapt writes; the parser skips it.
  const resMap = Buffer.alloc(8);
  resMap.writeUInt32LE(0x0101021b, 0);
  resMap.writeUInt32LE(0x0101021c, 4);
  const content = Buffer.concat([stringPool(strings, o.utf8), chunk(0x0180, Buffer.alloc(0), resMap), ...body]);
  return chunk(0x0003, Buffer.alloc(0), content);
}

function manifest(pkg: AttrValue, opts: { packageFirst?: boolean } = {}): XmlElement {
  const pkgAttr = { name: "package", value: pkg };
  const others = [
    { name: "versionCode", ns: ANDROID_NS, value: { int: 7 } as AttrValue },
    { name: "versionName", ns: ANDROID_NS, value: { raw: "1.0" } as AttrValue },
  ];
  return {
    name: "manifest",
    attrs: opts.packageFirst ? [pkgAttr, ...others] : [...others, pkgAttr],
    children: [
      {
        name: "application",
        attrs: [{ name: "label", ns: ANDROID_NS, value: { raw: "Smoke 한글" } }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "emu-lab-apk-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const so = Buffer.alloc(300, 0x7f);

test("abis: lib/<abi>/*.so only, sorted and unique, stored and deflated entries", async () => {
  await withTemp(async (dir) => {
    const apk = join(dir, "a.apk");
    await writeFile(
      apk,
      buildZip([
        { name: "AndroidManifest.xml", data: encodeAxml(manifest({ raw: "com.example.emusmoke" }), { utf8: false }), method: 8 },
        { name: "lib/armeabi-v7a/libmain.so", data: so, method: 8 },
        { name: "lib/arm64-v8a/libunity.so", data: so },
        { name: "lib/arm64-v8a/libmain.so", data: so, method: 8 },
        { name: "lib/arm64-v8a/sub/libdeep.so", data: so }, // nested: not an ABI dir entry
        { name: "lib/x86_64/readme.txt", data: "not a library" },
        { name: "assets/lib/x86/libfake.so", data: so },
        { name: "assets/bin/Data/data.unity3d", data: Buffer.alloc(5000, 1), method: 8 },
        { name: "lib/", data: "" },
      ]),
    );
    assert.deepEqual(await apkAbis(apk), ["arm64-v8a", "armeabi-v7a"]);
    assert.deepEqual(await readApkInfo(apk), { package: "com.example.emusmoke", abis: ["arm64-v8a", "armeabi-v7a"] });
  });
});

test("abis: an APK without native code gives []", async () => {
  await withTemp(async (dir) => {
    const apk = join(dir, "java.apk");
    await writeFile(apk, buildZip([{ name: "classes.dex", data: "dex\n035" }]));
    assert.deepEqual(await apkAbis(apk), []);
    assert.equal(await apkPackage(apk), null); // no manifest
  });
});

test("abisFromEntryNames mirrors the PS regex", () => {
  assert.deepEqual(abisFromEntryNames(["lib/x86/a.so", "lib/x86/b.so", "lib/x86_64/a.so", "lib/a.so", "xlib/arm/a.so"]), [
    "x86",
    "x86_64",
  ]);
});

for (const utf8 of [false, true]) {
  const enc = utf8 ? "UTF-8" : "UTF-16";
  for (const method of [0, 8] as const) {
    test(`package: ${enc} string pool, raw string value, ${method === 8 ? "deflated" : "stored"} manifest`, async () => {
      await withTemp(async (dir) => {
        const apk = join(dir, "p.apk");
        const xml = encodeAxml(manifest({ raw: "com.example.emusmoke" }), { utf8 });
        await writeFile(
          apk,
          buildZip([
            { name: "META-INF/MANIFEST.MF", data: "Manifest-Version: 1.0\r\n", method: 8 },
            { name: "AndroidManifest.xml", data: xml, method },
            { name: "lib/arm64-v8a/libmain.so", data: so, method: 8 },
          ]),
        );
        assert.equal(await apkPackage(apk), "com.example.emusmoke");
      });
    });
  }

  test(`package: ${enc} string pool, typed string value (raw index -1)`, () => {
    const xml = encodeAxml(manifest({ typedString: "com.example.typed" }, { packageFirst: true }), { utf8 });
    assert.equal(parseManifestPackage(xml), "com.example.typed");
  });

  test(`package: ${enc} long strings use the two-unit length form`, () => {
    const long = "com.example." + "a".repeat(200);
    const filler = ["x".repeat(40000)]; // > 0x7fff units: UTF-16 long length; UTF-8 2-byte length caps at 0x7fff
    const xml = encodeAxml(manifest({ raw: long }), { utf8, extraStrings: utf8 ? ["y".repeat(300)] : filler });
    assert.equal(parseManifestPackage(xml), long);
  });

  test(`package: ${enc} non-ASCII strings decode`, () => {
    const xml = encodeAxml(manifest({ raw: "com.example.한글" }), { utf8 });
    assert.equal(parseManifestPackage(xml), "com.example.한글");
  });
}

test("package: non-string package value or no package attribute gives null", () => {
  assert.equal(parseManifestPackage(encodeAxml(manifest({ int: 5 }), { utf8: false })), null);
  const noPkg: XmlElement = { name: "manifest", attrs: [{ name: "versionCode", ns: ANDROID_NS, value: { int: 1 } }] };
  assert.equal(parseManifestPackage(encodeAxml(noPkg, { utf8: true })), null);
  const other: XmlElement = { name: "resources", attrs: [{ name: "package", value: { raw: "com.example.not" } }] };
  assert.equal(parseManifestPackage(encodeAxml(other, { utf8: true })), null);
});

test("package: corrupt manifests give null, never throw", () => {
  const good = encodeAxml(manifest({ raw: "com.example.emusmoke" }), { utf8: false });
  assert.equal(parseManifestPackage(good), "com.example.emusmoke");
  assert.equal(parseManifestPackage(Buffer.alloc(0)), null);
  assert.equal(parseManifestPackage(Buffer.from("<?xml version=\"1.0\"?><manifest package=\"a.b\"/>")), null);
  for (let n = 1; n < good.length; n += 7) {
    assert.equal(parseManifestPackage(good.subarray(0, n)), null, `truncated at ${n}`);
  }
  // Damage chunk sizes and string offsets.
  const badSize = Buffer.from(good);
  badSize.writeUInt32LE(4, 8 + 4); // string pool chunk size smaller than its header
  assert.equal(parseManifestPackage(badSize), null);
  const badOffsets = Buffer.from(good);
  badOffsets.writeUInt32LE(0x7fffffff, 8 + 28); // first string offset far outside the pool
  badOffsets.writeUInt32LE(0x7fffffff, 8 + 32);
  badOffsets.writeUInt32LE(0x7fffffff, 8 + 36);
  assert.doesNotThrow(() => parseManifestPackage(badOffsets));
  // Random noise with a valid magic.
  for (let seed = 1; seed < 50; seed++) {
    const noise = Buffer.alloc(256);
    let x = seed;
    for (let i = 0; i < noise.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = x & 0xff;
    }
    noise.writeUInt16LE(0x0003, 0);
    noise.writeUInt16LE(8, 2);
    assert.doesNotThrow(() => parseManifestPackage(noise));
  }
});

test("zip: data descriptor entries, an archive comment, a prefix and trailing bytes still read", async () => {
  await withTemp(async (dir) => {
    const apk = join(dir, "d.apk");
    const xml = encodeAxml(manifest({ raw: "com.example.desc" }), { utf8: true });
    await writeFile(
      apk,
      buildZip(
        [
          { name: "AndroidManifest.xml", data: xml, method: 8, descriptor: true },
          { name: "lib/x86_64/libmain.so", data: so, method: 8, descriptor: true },
        ],
        { comment: "signed by test", prefix: Buffer.from("#!/bin/sh\nexit 0\n"), trailing: Buffer.from("junk") },
      ),
    );
    // A prefix shifts the real offsets, so build the offsets relative to the file start (buildZip does).
    assert.deepEqual(await readApkInfo(apk), { package: "com.example.desc", abis: ["x86_64"] });
  });
});

test("zip: an unsupported compression method or damaged deflate stream gives package null", async () => {
  await withTemp(async (dir) => {
    const xml = encodeAxml(manifest({ raw: "com.example.bz" }), { utf8: false });
    const bz = join(dir, "bz.apk");
    await writeFile(bz, buildZip([{ name: "AndroidManifest.xml", data: xml, method: 12 }, { name: "lib/x86/a.so", data: so }]));
    assert.deepEqual(await readApkInfo(bz), { package: null, abis: ["x86"] });

    const broken = buildZip([{ name: "AndroidManifest.xml", data: xml, method: 8 }]);
    // Overwrite the start of the deflate data (after the 30-byte header, the name and the 4-byte extra).
    broken.fill(0xff, 30 + "AndroidManifest.xml".length + 4, 30 + "AndroidManifest.xml".length + 4 + 8);
    const br = join(dir, "broken.apk");
    await writeFile(br, broken);
    assert.equal(await apkPackage(br), null);
  });
});

test("zip: not a zip, empty, missing and ZIP64 files throw a clear BAD_OPTION error", async () => {
  await withTemp(async (dir) => {
    const text = join(dir, "text.apk");
    await writeFile(text, "this is not an apk at all, just some text that is long enough");
    const empty = join(dir, "empty.apk");
    await writeFile(empty, "");
    const folder = join(dir, "folder.apk");
    await mkdir(folder);
    const z64 = buildZip([{ name: "a.txt", data: "a" }]);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10); // entry count escape = ZIP64
    const zip64 = join(dir, "zip64.apk");
    await writeFile(zip64, z64);
    const cdDamaged = buildZip([{ name: "a.txt", data: "a" }]);
    cdDamaged.writeUInt32LE(0xdeadbeef, cdDamaged.length - 22 - (46 + "a.txt".length)); // central header signature
    const damaged = join(dir, "damaged.apk");
    await writeFile(damaged, cdDamaged);

    const cases: [string, RegExp][] = [
      [text, /Not a zip\/APK file: .*text\.apk \(no end of central directory record\)/],
      [empty, /Not a zip\/APK file: .*empty\.apk \(only 0 bytes\)/],
      [folder, /folder\.apk/],
      [zip64, /ZIP64 archives are not supported/],
      [damaged, /central directory entry 0 is damaged/],
      [join(dir, "missing.apk"), /APK not found: .*missing\.apk/],
    ];
    for (const [path, re] of cases) {
      for (const fn of [apkAbis, apkPackage, readApkInfo]) {
        await assert.rejects(
          () => fn(path),
          (err: unknown) => isEmuError(err, "BAD_OPTION") && re.test((err as Error).message),
          `${fn.name}(${path})`,
        );
      }
    }
  });
});

const sampleApk = join(import.meta.dirname, "..", "sample", "EmuSmoke", "Builds", "Android", "app.apk");

test("sample APK: package and ABIs", { skip: existsSync(sampleApk) ? false : "sample APK not built" }, async () => {
  const info = await readApkInfo(sampleApk);
  // The sample's id is com.example.emusmoke; an APK built before that rename keeps its older com.<x>.emusmoke id.
  assert.match(info.package ?? "", /^com\.[a-z0-9_]+\.emusmoke$/, `unexpected package ${info.package}`);
  assert.deepEqual(info.abis, ["arm64-v8a"]);
  assert.equal(await apkPackage(sampleApk), info.package);
  assert.deepEqual(await apkAbis(sampleApk), ["arm64-v8a"]);
});
