// The ZIP container of a .docx, read and written in memory. Entry names are never
// used as disk paths. An entry that is not replaced keeps its compressed bytes.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { Refused } from "../markdown.ts";

export const ZIP_LIMITS = { entries: 5_000, entryBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };

export interface Entry {
  name: string;
  method: number;
  flags: number;
  time: number;
  crc: number;
  size: number;
  packed: Uint8Array;
}

const damaged = (why: string): never => {
  throw new Refused(`the Word file is damaged, partly written or not supported: ${why}`);
};

/** Every entry, each one expanded once so that its size and CRC are known good. */
export function readZip(bytes: Uint8Array, limits = ZIP_LIMITS): Entry[] {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--)
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) damaged("it is not a ZIP file with a directory");
  const count = data.readUInt16LE(end + 10);
  if (count > limits.entries) damaged("too many entries");
  let at = data.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) damaged("ZIP64 is not supported");
  const entries: Entry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) damaged("a broken directory entry");
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const time = data.readUInt32LE(at + 12);
    const crc = data.readUInt32LE(at + 16);
    const packedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const [nameLength, extra, comment] = [data.readUInt16LE(at + 28), data.readUInt16LE(at + 30), data.readUInt16LE(at + 32)];
    const local = data.readUInt32LE(at + 42);
    const name = data.toString("utf8", at + 46, at + 46 + nameLength);
    if (flags & 1) damaged("it is encrypted");
    if (names.has(name)) damaged("two entries have one name");
    names.add(name);
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) damaged("a broken entry");
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (start + packedSize > data.length) damaged("an entry is cut short");
    total += size;
    if (size > limits.entryBytes || total > limits.totalBytes) damaged("it expands past the size limit");
    const entry = { name, method, flags, time, crc, size, packed: data.subarray(start, start + packedSize) };
    const raw = expand(entry, limits.entryBytes);
    if (raw.length !== size || crc32(raw) !== crc) damaged(`${name} does not match its size and CRC`);
    entries.push(entry);
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

function expand(entry: Entry, limit = ZIP_LIMITS.entryBytes): Buffer {
  if (entry.method === 0) return Buffer.from(entry.packed);
  if (entry.method !== 8) return damaged("an unknown compression");
  try {
    return inflateRawSync(entry.packed, { maxOutputLength: limit });
  } catch {
    return damaged(`${entry.name} cannot be expanded`);
  }
}

export function entryText(entries: Entry[], name: string): string | undefined {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(expand(entry));
  } catch (e) {
    if (e instanceof Refused) throw e;
    return damaged(`${name} is not UTF-8`);
  }
}

export function newEntry(name: string, text: string): Entry {
  const raw = Buffer.from(text, "utf8");
  // 1980-01-01, so that the same content gives the same bytes.
  return { name, method: 8, flags: 0x800, time: 0x00210000, crc: crc32(raw), size: raw.length, packed: deflateRawSync(raw) };
}

/** `entries` with the named parts replaced or added. */
export function replaceParts(entries: Entry[], parts: Map<string, string>): Entry[] {
  const out = entries.map((e) => {
    const text = parts.get(e.name);
    return text === undefined ? e : { ...newEntry(e.name, text), time: e.time };
  });
  for (const [name, text] of parts) if (!entries.some((e) => e.name === name)) out.push(newEntry(name, text));
  return out;
}

export function writeZip(entries: Entry[]): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    // Sizes go in the header, so no data descriptor follows the data.
    const flags = e.flags & ~0x8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(e.time, 10);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.packed.length, 18);
    local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    local.copy(central, 8, 6, 28);
    central.writeUInt32LE(offset, 42);
    files.push(local, name, Buffer.from(e.packed));
    directory.push(central, name);
    offset += 30 + name.length + e.packed.length;
  }
  const size = directory.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...directory, end]);
}
