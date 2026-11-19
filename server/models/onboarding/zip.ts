// Purpose: Validates and streams bounded ZIP provider archives into an unpublished payload.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open as openFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const maximumUnpackedBytes = 2 * 1024 * 1024 * 1024;
const maximumEntries = 10_000;
const eocdSignature = 0x06054b50;
const centralHeaderSignature = 0x02014b50;
const localHeaderSignature = 0x04034b50;

interface ZipEntry {
  readonly fileName: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function validateEntry(
  name: string,
  directory: boolean,
  uncompressedSize: number,
  mode: number,
  encrypted: boolean,
  method: number,
  layout: "flat" | "npm",
  names: Set<string>,
  unpacked: number,
  count: number,
) {
  const parts = name.replace(/\/$/, "").split("/");
  const identity = parts.join("/").toLowerCase();
  if (
    (layout === "npm" && parts[0] !== "package") ||
    path.posix.isAbsolute(name) ||
    /[\\:<>"|?*]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
          part,
        ),
    ) ||
    (mode !== 0 && mode !== (directory ? 0x4000 : 0x8000)) ||
    encrypted ||
    (method !== 0 && method !== 8) ||
    (directory && uncompressedSize !== 0) ||
    unpacked > maximumUnpackedBytes ||
    count >= maximumEntries ||
    names.has(identity)
  ) {
    throw new Error("Provider archive contains unsupported entries.");
  }
  return identity;
}

function findEocd(tail: Buffer): number {
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (tail.readUInt32LE(offset) !== eocdSignature) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw new Error("Invalid ZIP archive.");
}

async function readEntries(
  archive: string,
  layout: "flat" | "npm",
  signal: AbortSignal,
): Promise<ZipEntry[]> {
  signal.throwIfAborted();
  const handle = await openFile(archive, "r");
  try {
    const fileSize = (await handle.stat()).size;
    if (fileSize < 22) throw new Error("Invalid ZIP archive.");
    const tailLength = Math.min(fileSize, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, fileSize - tailLength);
    const eocdOffset = findEocd(tail);
    const disk = tail.readUInt16LE(eocdOffset + 4);
    const cdDisk = tail.readUInt16LE(eocdOffset + 6);
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const cdSize = tail.readUInt32LE(eocdOffset + 12);
    const cdOffset = tail.readUInt32LE(eocdOffset + 16);
    if (
      disk !== 0 ||
      cdDisk !== 0 ||
      entryCount === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff ||
      cdOffset + cdSize > fileSize - tailLength + eocdOffset
    ) {
      throw new Error("Provider archive contains unsupported entries.");
    }
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let unpacked = 0;
    let cursor = 0;
    for (let index = 0; index < entryCount; index++) {
      signal.throwIfAborted();
      if (
        cursor + 46 > cd.length ||
        cd.readUInt32LE(cursor) !== centralHeaderSignature
      ) {
        throw new Error("Invalid ZIP archive.");
      }
      const flags = cd.readUInt16LE(cursor + 8);
      const method = cd.readUInt16LE(cursor + 10);
      const compressedSize = cd.readUInt32LE(cursor + 20);
      const uncompressedSize = cd.readUInt32LE(cursor + 24);
      const nameLength = cd.readUInt16LE(cursor + 28);
      const extraLength = cd.readUInt16LE(cursor + 30);
      const commentLength = cd.readUInt16LE(cursor + 32);
      const externalAttributes = cd.readUInt32LE(cursor + 38);
      const localHeaderOffset = cd.readUInt32LE(cursor + 42);
      const headerEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (headerEnd > cd.length) throw new Error("Invalid ZIP archive.");
      const fileName = cd
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString("utf8");
      const directory = fileName.endsWith("/");
      const mode = (externalAttributes >>> 16) & 0xf000;
      unpacked += uncompressedSize;
      const identity = validateEntry(
        fileName,
        directory,
        uncompressedSize,
        mode,
        (flags & 1) !== 0,
        method,
        layout,
        names,
        unpacked,
        entries.length,
      );
      names.add(identity);
      entries.push({
        fileName,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor = headerEnd;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readDataOffset(
  archive: string,
  entry: ZipEntry,
): Promise<number> {
  const handle = await openFile(archive, "r");
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(
      header,
      0,
      30,
      entry.localHeaderOffset,
    );
    if (bytesRead < 30 || header.readUInt32LE(0) !== localHeaderSignature) {
      throw new Error("Invalid ZIP archive.");
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    return entry.localHeaderOffset + 30 + nameLength + extraLength;
  } finally {
    await handle.close();
  }
}

/**
 * Extracts regular files/directories from a verified ZIP into a fresh directory.
 * Validates all names, types, and cumulative sizes before writing, rejects
 * Windows aliases and duplicate paths, and cancels streams on abort.
 * @example await extractZip(archive, payload, "flat", signal);
 */
export async function extractZip(
  archive: string,
  payload: string,
  layout: "flat" | "npm",
  signal: AbortSignal,
): Promise<void> {
  const entries = await readEntries(archive, layout, signal);
  for (const entry of entries) {
    signal.throwIfAborted();
    const parts = entry.fileName.split("/");
    if (layout === "npm") parts.shift();
    const destination = path.join(payload, ...parts);
    if (entry.fileName.endsWith("/")) {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    if (entry.compressedSize === 0 && entry.uncompressedSize === 0) {
      await writeFile(destination, Buffer.alloc(0), { flag: "wx", signal });
      continue;
    }
    const dataOffset = await readDataOffset(archive, entry);
    let written = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > entry.uncompressedSize) {
          callback(
            new Error("Provider archive entry exceeds declared unpacked size."),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    const source = createReadStream(archive, {
      start: dataOffset,
      end: dataOffset + entry.compressedSize - 1,
    });
    const output = createWriteStream(destination, { flags: "wx" });
    if (entry.method === 8) {
      await pipeline(source, createInflateRaw(), limiter, output, { signal });
    } else {
      await pipeline(source, limiter, output, { signal });
    }
    if (written !== entry.uncompressedSize) {
      throw new Error("Provider archive entry ended unexpectedly.");
    }
  }
}
