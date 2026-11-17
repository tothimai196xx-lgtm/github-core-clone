// gitproto.ts — dependency-free git object model, pkt-line codec and packfile
// read/write, for the github-core-clone-01 forge. Node built-ins only.
// Every function here is exercised by the suite's git client (kit program/env/src/git-client.ts),
// so the formats match it exactly: SHA-1 ids, pack version 2, plain (non-delta) objects on
// write, OFS_DELTA and REF_DELTA on read.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 of "<type> <size>\0<bytes>". */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, Buffer.from(data)]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// --------------------------------------------------------------------------------------------
// pkt-line
// --------------------------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktEncode(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error(`pkt-line payload ${data.length} bytes exceeds the maximum`);
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in `buf`. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw bytes follow (a packfile)
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error(`pkt-line length ${len} is invalid at offset ${offset}`);
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

export function pktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktEncode(item));
  }
  return Buffer.concat(parts);
}

/** One sideband packet: band byte (1 = data, 2 = progress) + payload, pkt-framed. */
export function sideband(band: 1 | 2, data: Uint8Array): Buffer {
  return pktEncode(Buffer.concat([Buffer.from([band]), Buffer.from(data)]));
}

/** Split `data` into sideband band-1 packets of at most `chunk` payload bytes each. */
export function sidebandChunks(data: Buffer, chunk = 65500): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    out.push(sideband(1, data.subarray(offset, Math.min(data.length, offset + chunk))));
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// trees / commits / tags
// --------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  const buf = Buffer.from(data);
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = buf.subarray(offset, space).toString('ascii');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > buf.length) throw new Error('malformed tree: truncated oid');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: entries sort by name, directories as if the name had a trailing '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  // A blank line separates the headers from the message; without it the message parses as empty.
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// --------------------------------------------------------------------------------------------
// packfile
// --------------------------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a pack version 2 of plain (non-delta) objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next, first: buffer[start] ?? 0 };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let baseOffset = byte & 0x7f;
  let next = start + 1;
  while (byte & 0x80) {
    byte = buffer[next] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset, next };
}

/** Apply a git delta to its base, returning the reconstructed object. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++] ?? 0;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++] ?? 0;
      if (op & 0x02) offset |= (delta[pos++] ?? 0) << 8;
      if (op & 0x04) offset |= (delta[pos++] ?? 0) << 16;
      if (op & 0x08) offset |= (delta[pos++] ?? 0) << 24;
      if (op & 0x10) size = delta[pos++] ?? 0;
      if (op & 0x20) size |= (delta[pos++] ?? 0) << 8;
      if (op & 0x40) size |= (delta[pos++] ?? 0) << 16;
      if (size === 0) size = 0x10000;
      out.push(Buffer.from(base.subarray(offset, offset + size)));
      total += size;
    } else if (op !== 0) {
      out.push(Buffer.from(delta.subarray(pos, pos + op)));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (total !== targetSize) throw new Error(`delta target size ${total} does not match ${targetSize}`);
  return Buffer.concat(out);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
  version: number;
}

/** Read a pack (v2/v3), resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(pack: Uint8Array): PackReadResult {
  const buf = Buffer.from(pack);
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile (bad magic)');
  }
  const version = buf.readUInt32BE(4);
  const declaredCount = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  // First pass: inflate every entry; deltas resolve against entries already read (git writes
  // bases before their deltas) or, for REF_DELTA, against objects already in the map.
  type Pending = { offset: number; type: ObjType; data: Buffer; baseOid?: string; baseOffset?: number };
  const pending: Pending[] = [];
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(buf, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(buf, offset);
      offset = after;
      const { data, next: end } = inflateBounded(buf, offset);
      offset = end;
      pending.push({ offset: entryOffset, type: 'blob', data, baseOffset: entryOffset - baseOffset });
      deltaCount += 1;
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next: end } = inflateBounded(buf, offset);
      offset = end;
      pending.push({ offset: entryOffset, type: 'blob', data, baseOid });
      deltaCount += 1;
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next: end } = inflateBounded(buf, offset);
      offset = end;
      if (data.length !== size) throw new Error(`pack object size ${data.length} does not match header ${size}`);
      const object: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
    }
  }
  // Resolve deltas (possibly chained): iterate until every pending entry resolves.
  let remaining = pending;
  while (remaining.length > 0) {
    const nextRound: Pending[] = [];
    let progressed = false;
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.baseOid !== undefined) base = objects.get(item.baseOid);
      else if (item.baseOffset !== undefined) base = byOffset.get(item.baseOffset);
      if (base === undefined) {
        nextRound.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.data);
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      objects.set(oid, object);
      byOffset.set(item.offset, object);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing (thin pack without its base)');
    remaining = nextRound;
  }
  return { objects, deltaCount, declaredCount, version };
}

/** Inflate one zlib stream starting at `offset`, returning the data and the offset just past it. */
export function inflateBounded(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes, so "inflateSync(prefix) succeeds" is false
  // for every prefix shorter than the stream and true from the stream's end on: binary
  // search finds the smallest succeeding prefix, which is exactly the stream end.
  const ok = (end: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, end));
    } catch {
      return null;
    }
  };
  if (ok(buffer.length) === null) throw new Error('zlib stream does not terminate');
  let lo = offset;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = ok(lo);
  if (data === null) throw new Error('zlib stream does not terminate');
  return { data, next: lo };
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = sha1Hex(body);
  const actual = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  return { ok: expected === actual, expected, actual };
}
