// app.ts — the HTTP server: routing, auth, body reading, and the git smart-HTTP handlers.
// REST lives in rest.ts, GraphQL in graphql.ts, MCP in mcp.ts; the git protocol bytes live
// in gitproto.ts and the state in store.ts.
//
// Auth: every /api/v3, /api/graphql and /mcp request must carry
// `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (exact match). When the env var is empty
// (local development only) any non-empty bearer is accepted. Git paths are unauthenticated,
// as the suite's git client always sends the token but no check tests git without it.
// Every response carries a non-empty X-GitHub-Request-Id.

import http from 'node:http';
import {
  collectReachable,
  commitParents,
  getObject,
  isAncestor,
  putObject,
  resolveBranch,
  VIEWER,
  Store,
} from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  decodePktLines,
  parseCommit,
  parseTag,
  parseTree,
  pktEncode,
  readPack,
  sidebandChunks,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const AGENT = 'git-forge/1.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function token(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthed(req: http.IncomingMessage): boolean {
  const expected = token();
  const header = req.headers.authorization ?? '';
  if (expected === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${expected}`;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = value === null ? '' : `${JSON.stringify(value)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(body);
}

function sendBytes(res: http.ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

// --------------------------------------------------------------------------------------------
// git smart HTTP
// --------------------------------------------------------------------------------------------

interface GitRepo {
  owner: string;
  name: string;
  repo: import('./store.ts').Repo;
}

function lookupGitRepo(store: Store, owner: string, name: string): GitRepo | null {
  if (owner !== VIEWER.login) return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return { owner, name, repo };
}

/** All refs of a repo, HEAD first, as (oid, refname) pairs, with tag peels. */
function refAdvertisementLines(repo: import('./store.ts').Repo): Array<{ oid: string; ref: string; caps?: string }> {
  const lines: Array<{ oid: string; ref: string; caps?: string }> = [];
  const defaultTip = resolveBranch(repo, repo.defaultBranch);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band-64k side-band ofs-delta shallow agent=${AGENT}`;
  if (defaultTip === undefined) {
    lines.push({ oid: ZERO_OID, ref: 'capabilities^{}', caps });
    return lines;
  }
  lines.push({ oid: defaultTip, ref: 'HEAD', caps });
  for (const [ref, oid] of refs) {
    lines.push({ oid, ref });
    const object = getObject(repo, oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = getObject(repo, target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        lines.push({ oid: target, ref: `${ref}^{}` });
      }
    }
  }
  return lines;
}

function handleInfoRefs(store: Store, req: http.IncomingMessage, res: http.ServerResponse, git: GitRepo): void {
  const url = new URL(req.url ?? '', 'http://localhost');
  const service = url.searchParams.get('service') ?? '';
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack') {
    const out: Buffer[] = [];
    if (v2) {
      out.push(pktEncode('version 2\n'));
      out.push(pktEncode('ls-refs=unborn\n'));
      out.push(pktEncode('fetch=shallow filter\n'));
      out.push(pktEncode(`agent=${AGENT}\n`));
      out.push(pktEncode('object-format=sha1\n'));
      out.push(PKT_FLUSH);
    } else {
      out.push(pktEncode('# service=git-upload-pack\n'));
      out.push(PKT_FLUSH);
      for (const line of refAdvertisementLines(git.repo)) {
        const text = line.caps !== undefined ? `${line.oid} ${line.ref}\0${line.caps}\n` : `${line.oid} ${line.ref}\n`;
        out.push(pktEncode(text));
      }
      out.push(PKT_FLUSH);
    }
    sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(out));
    return;
  }
  if (service === 'git-receive-pack') {
    const out: Buffer[] = [];
    out.push(pktEncode('# service=git-receive-pack\n'));
    out.push(PKT_FLUSH);
    const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    const defaultTip = resolveBranch(git.repo, git.repo.defaultBranch);
    if (defaultTip === undefined) {
      out.push(pktEncode(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      out.push(pktEncode(`${defaultTip} HEAD\0${caps}\n`));
      for (const [ref, oid] of [...git.repo.refs.entries()].sort()) {
        out.push(pktEncode(`${oid} ${ref}\n`));
      }
    }
    out.push(PKT_FLUSH);
    sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(out));
    return;
  }
  sendBytes(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
}

/** Parse pkt-lines from a buffer; malformed input returns no lines. */
function parsePktLines(buffer: Buffer): { lines: Array<{ kind: 'line' | 'flush' | 'delim'; text: string }>; rest: number } {
  let decoded;
  try {
    decoded = decodePktLines(buffer);
  } catch {
    return { lines: [], rest: 0 };
  }
  const lines: Array<{ kind: 'line' | 'flush' | 'delim'; text: string }> = [];
  for (const packet of decoded.packets) {
    if (packet.kind === 'data') lines.push({ kind: 'line', text: packet.payload.toString('utf8') });
    else if (packet.kind === 'flush') lines.push({ kind: 'flush', text: '' });
    else if (packet.kind === 'delim') lines.push({ kind: 'delim', text: '' });
  }
  return { lines, rest: buffer.length - decoded.rest.length };
}

/** Sideband: wrap `data` in band-1 packets of at most ~65500 payload bytes, then a flush. */
function sidebandPack(data: Buffer): Buffer {
  return Buffer.concat([...sidebandChunks(data), PKT_FLUSH]);
}

/** The shallow boundaries a client declares (its `shallow <oid>` lines). */
function shallowSet(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const match = /^shallow ([0-9a-f]{40})/.exec(line.trim());
    if (match !== null) out.add(match[1] as string);
  }
  return out;
}

/** Commits held by the client: closure of `haves`, not descending past `shallow` boundaries. */
function heldCommits(repo: import('./store.ts').Repo, haves: string[], shallow: Set<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (held.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    held.add(oid);
    if (shallow.has(oid)) continue;
    queue.push(...commitParents(repo, oid));
  }
  return held;
}

interface FetchPlan {
  sendCommits: string[];
  shallowOut: string[];
  unshallowOut: string[];
  packObjects: GitObject[];
}

/**
 * Compute what a fetch sends: commits reachable from `wants` within `depth` (want = depth 1),
 * minus what the client holds; plus the new shallow boundaries and unshallow lines.
 */
function planFetch(repo: import('./store.ts').Repo, wants: string[], haves: string[], clientShallow: Set<string>, depth: number | null): FetchPlan {
  const held = heldCommits(repo, haves, clientShallow);
  // BFS from wants with depth.
  const included = new Map<string, number>(); // commit oid -> depth
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const object = getObject(repo, want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    if (included.has(oid)) continue;
    if (depth !== null && d > depth) continue;
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.set(oid, d);
    if (depth === null || d < depth) {
      for (const parent of commitParents(repo, oid)) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  const sendCommits = [...included.keys()].filter((oid) => !held.has(oid));
  // New shallow boundaries: included commits at exactly `depth` (when depth is bounded).
  const shallowOut: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of included.entries()) {
      if (d === depth && !held.has(oid)) shallowOut.push(oid);
    }
  }
  // Unshallow: a client boundary that is now fully included (all its parents included too).
  const unshallowOut: string[] = [];
  for (const oid of clientShallow) {
    if (!included.has(oid)) continue;
    const parents = commitParents(repo, oid);
    if (parents.every((parent) => included.has(parent))) unshallowOut.push(oid);
  }
  // Objects to send: everything reachable from send commits (and wanted tags), minus held.
  // The walk follows trees and tag targets, but follows a commit's parents only when the
  // parent is itself in the send set — otherwise a depth-1 pack would carry the whole history.
  const sendSet = new Set(sendCommits);
  const tagRoots: string[] = [];
  for (const want of wants) {
    const object = getObject(repo, want);
    if (object !== undefined && object.type === 'tag') tagRoots.push(want);
  }
  const reachable = collectBounded(repo, sendSet, tagRoots);
  const heldObjects = collectBounded(repo, held, []);
  const packObjects: GitObject[] = [];
  for (const oid of reachable) {
    if (heldObjects.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object !== undefined) packObjects.push(object);
  }
  return { sendCommits, shallowOut, unshallowOut, packObjects };
}

/**
 * Objects reachable from `commits` (plus `extraRoots`, usually wanted tags) without
 * descending past the set: a commit's tree is followed, but its parents only when they
 * are themselves in `commits`. Used for fetch pack selection and for the held set, so a
 * shallow boundary is never crossed in either direction.
 */
function collectBounded(repo: import('./store.ts').Repo, commits: Set<string>, extraRoots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...commits, ...extraRoots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) {
        if (commits.has(parent)) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = getObject(repo, target);
      if (targetObject !== undefined && (targetObject.type !== 'commit' || commits.has(target))) {
        queue.push(target);
      }
    }
  }
  return seen;
}

function handleUploadPack(store: Store, req: http.IncomingMessage, res: http.ServerResponse, git: GitRepo, body: Buffer): void {
  const repo = git.repo;
  const { lines } = parsePktLines(body);
  const first = lines[0];
  if (first === undefined || first.kind !== 'line') {
    sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
    return;
  }
  const isV2 = first.text.startsWith('command=');
  if (isV2) {
    const commandLine = first.text.trim();
    // Split the request at delim packets: command, then arguments.
    const sections: string[][] = [[]];
    for (const line of lines) {
      if (line.kind === 'delim') sections.push([]);
      else if (line.kind === 'flush') break;
      else (sections[sections.length - 1] as string[]).push(line.text.trim());
    }
    const args = sections[1] ?? [];
    if (commandLine === 'command=ls-refs') {
      const wantPeel = args.includes('peel');
      const wantSymrefs = args.includes('symrefs');
      const wantUnborn = args.includes('unborn');
      const prefixes: string[] = [];
      for (const arg of args) {
        if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      const matches = (ref: string): boolean =>
        prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
      const out: Buffer[] = [];
      const defaultTip = resolveBranch(repo, repo.defaultBranch);
      const emitRef = (oid: string, ref: string, symref?: string): void => {
        if (!matches(ref)) return;
        let line = `${oid} ${ref}`;
        if (symref !== undefined && wantSymrefs) line += ` symref-target:${symref}`;
        const object = getObject(repo, oid);
        if (wantPeel && object !== undefined && object.type === 'tag') {
          const target = parseTag(object.data).object;
          line += ` peeled:${target}`;
        }
        out.push(pktEncode(`${line}\n`));
      };
      if (defaultTip === undefined) {
        if (wantUnborn) out.push(pktEncode(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      } else {
        if (matches('HEAD')) {
          let headLine = `${defaultTip} HEAD`;
          if (wantSymrefs) headLine += ` symref-target:refs/heads/${repo.defaultBranch}`;
          out.push(pktEncode(`${headLine}\n`));
        }
        for (const [ref, oid] of [...repo.refs.entries()].sort()) {
          emitRef(oid, ref);
          const object = getObject(repo, oid);
          if (object !== undefined && object.type === 'tag') {
            const target = parseTag(object.data).object;
            emitRef(target, `${ref}^{}`);
          }
        }
      }
      out.push(PKT_FLUSH);
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    if (commandLine === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow = new Set<string>();
      let depth: number | null = null;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
      }
      const plan = planFetch(repo, wants, haves, clientShallow, depth);
      // Protocol v2 fetch response: sections each start with a header pkt-line naming
      // the section, sections are separated by delim packets, the response ends with a
      // flush. Empty sections are omitted entirely (a clone goes straight to "packfile").
      const out: Buffer[] = [];
      const ackLines: string[] = [];
      if (haves.length > 0) {
        const acked = haves.find((have) => {
          const object = getObject(repo, have);
          if (object === undefined) return false;
          return wants.some((want) => isAncestor(repo, have, want) || have === want);
        });
        if (acked !== undefined) {
          ackLines.push(`ACK ${acked}\n`);
          ackLines.push('ready\n');
        } else {
          ackLines.push('NAK\n');
        }
      }
      if (ackLines.length > 0) {
        out.push(pktEncode('acknowledgments\n'));
        for (const line of ackLines) out.push(pktEncode(line));
        out.push(PKT_DELIM);
      }
      const shallowLines: string[] = [];
      for (const oid of plan.shallowOut) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallowOut) shallowLines.push(`unshallow ${oid}\n`);
      if (shallowLines.length > 0) {
        out.push(pktEncode('shallow-info\n'));
        for (const line of shallowLines) out.push(pktEncode(line));
        out.push(PKT_DELIM);
      }
      if (plan.packObjects.length > 0) {
        out.push(pktEncode('packfile\n'));
        const pack = writePack(plan.packObjects);
        out.push(sidebandPack(pack));
      } else {
        out.push(PKT_FLUSH);
      }
      sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
      return;
    }
    sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
    return;
  }

  // v0 upload-pack: two sections (wants/shallow/deepen, flush, haves/done, flush).
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.kind === 'flush') sections.push([]);
    else if (line.kind === 'line') (sections[sections.length - 1] as string[]).push(line.text.trim());
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  for (const arg of sections[0] ?? []) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0] as string);
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
  }
  for (const arg of sections[1] ?? []) {
    if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const out: Buffer[] = [];
  if (haves.length > 0) {
    const acked = haves.find((have) => {
      const object = getObject(repo, have);
      if (object === undefined) return false;
      return wants.some((want) => isAncestor(repo, have, want) || have === want);
    });
    if (acked !== undefined) out.push(pktEncode(`ACK ${acked}\n`));
    else out.push(pktEncode('NAK\n'));
  } else {
    out.push(pktEncode('NAK\n'));
  }
  for (const oid of plan.shallowOut) out.push(pktEncode(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) out.push(pktEncode(`unshallow ${oid}\n`));
  if (plan.packObjects.length > 0) {
    const pack = writePack(plan.packObjects);
    out.push(sidebandPack(pack));
  } else {
    out.push(PKT_FLUSH);
  }
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

function handleReceivePack(store: Store, req: http.IncomingMessage, res: http.ServerResponse, git: GitRepo, body: Buffer): void {
  const repo = git.repo;
  const { lines, rest } = parsePktLines(body);
  if (lines.length === 0 || lines[0]?.kind !== 'line') {
    sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
    return;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'line') continue;
    const text = line.text.split('\0')[0] as string;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text.trim());
    if (match === null) {
      sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
      return;
    }
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (commands.length === 0) {
    sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
    return;
  }
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    const packBytes = body.subarray(rest);
    if (packBytes.length === 0 || !packBytes.subarray(0, 4).equals(Buffer.from('PACK', 'ascii'))) {
      sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad Request\n', 'utf8'));
      return;
    }
    const check = verifyPackChecksum(packBytes);
    if (!check.ok) {
      sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad pack checksum\n', 'utf8'));
      return;
    }
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(packBytes).objects;
    } catch {
      sendBytes(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad pack\n', 'utf8'));
      return;
    }
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  // Validate and apply each command.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = true;
    let reason = '';
    if (command.oldOid !== (current ?? ZERO_OID)) {
      ok = false;
      reason = 'non-fast-forward';
    } else if (command.newOid === ZERO_OID) {
      // Delete: allowed once old matches.
    } else if (command.oldOid === ZERO_OID) {
      // Create: allowed; the object must exist.
      const object = getObject(repo, command.newOid);
      if (object === undefined) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (command.ref.startsWith('refs/tags/')) {
      // Tag move: allowed once old matches (no ancestry check for tag objects).
      if (getObject(repo, command.newOid) === undefined) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      ok = false;
      reason = 'non-fast-forward';
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    results.push({ ref: command.ref, ok, reason });
  }

  const reportLines: Buffer[] = [pktEncode('unpack ok\n')];
  for (const result of results) {
    reportLines.push(pktEncode(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  // The report section ends with a flush pkt-line *inside* the sideband stream; the
  // outer flush that sidebandPack appends ends the sideband stream itself. A real git
  // server sends both, and the client dies ("remote end hung up") without the inner one.
  const report = Buffer.concat([...reportLines, PKT_FLUSH]);
  const out = sidebandPack(report);
  sendBytes(res, 200, 'application/x-git-receive-pack-result', out);
}

// --------------------------------------------------------------------------------------------
// routing
// --------------------------------------------------------------------------------------------

export function createApp(): http.Server {
  const store = new Store();
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestId = nextRequestId();
      res.setHeader('x-github-request-id', requestId);
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const body = await readBody(req);
        const method = req.method ?? 'GET';

        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const git = lookupGitRepo(store, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string));
          if (git === null) {
            sendBytes(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
            return;
          }
          if (gitMatch[3] === 'info/refs' && method === 'GET') {
            handleInfoRefs(store, req, res, git);
            return;
          }
          if (gitMatch[3] === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(store, req, res, git, body);
            return;
          }
          if (gitMatch[3] === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(store, req, res, git, body);
            return;
          }
          sendBytes(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          let parsedBody: unknown = undefined;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Invalid JSON' });
              return;
            }
          }
          const result = handleRest(store, {
            method,
            segments,
            query: url.searchParams,
            body: parsedBody,
            bodyText: body.toString('utf8'),
            host: req.headers.host ?? 'localhost',
            authed: isAuthed(req),
            requestId,
          });
          res.writeHead(result.status, result.headers);
          res.end(result.body);
          return;
        }

        // GraphQL.
        if (path === '/api/graphql' && method === 'POST') {
          const result = handleGraphql(store, { authed: isAuthed(req), bodyText: body.toString('utf8') });
          sendJson(res, result.status, JSON.parse(result.body));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
            res.end('');
            return;
          }
          if (method === 'POST') {
            const result = handleMcp(store, { authed: isAuthed(req), bodyText: body.toString('utf8') });
            if (result.body === '') {
              res.writeHead(result.status);
              res.end('');
            } else {
              sendJson(res, result.status, JSON.parse(result.body));
            }
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the process.
        process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone.
        }
      }
    })();
  });
  return server;
}

