// store.ts — the forge's whole state, in memory. One Store holds every repository:
// its git objects and refs, issues, pull requests, labels and comments. Nothing is
// persisted: a trial runs one process and the suite is its only client.
//
// Determinism: every timestamp the store mints comes from a counter starting at a fixed
// epoch, never from the wall clock, so two runs driven with the same requests mint the
// same commit ids and the same created_at values.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
  ZERO_OID,
} from './gitproto.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
const BASE_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // the base tip when the pull request was opened (its merge-base)
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  owner: string;
  name: string;
  id: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextId = 1;
  private seq = 0;

  /** The next deterministic timestamp (ISO string), one second per mint. */
  nowIso(): string {
    this.seq += 1;
    return new Date((BASE_EPOCH_SEC + this.seq) * 1000).toISOString();
  }

  /** The next deterministic timestamp (epoch seconds). */
  nowSec(): number {
    this.seq += 1;
    return BASE_EPOCH_SEC + this.seq;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      owner,
      name,
      id: this.nextId,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextId += 1;
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

// --------------------------------------------------------------------------------------------
// git objects
// --------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function identityLine(tsSec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${tsSec} +0000`;
}

export function createCommit(
  store: Store,
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const ts = store.nowSec();
  const data = buildCommit({
    tree,
    parents,
    author: identityLine(ts),
    committer: identityLine(ts),
    message,
  });
  return putObject(repo, 'commit', data);
}

export function createTagObject(store: Store, repo: Repo, target: string, type: string, name: string): string {
  const ts = store.nowSec();
  const header = [
    `object ${target}`,
    `type ${type}`,
    `tag ${name}`,
    `tagger ${identityLine(ts)}`,
  ].join('\n');
  // A blank line separates the headers from the message.
  return putObject(repo, 'tag', Buffer.from(`${header}\n\n${name}\n`, 'utf8'));
}

// --------------------------------------------------------------------------------------------
// trees
// --------------------------------------------------------------------------------------------

/** Set (or delete, with blobOid null) one path in a tree, returning the new root tree oid. */
export function setPath(repo: Repo, rootTreeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error('empty path');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = treeOid === null ? [] : parseTree(getObject(repo, treeOid)?.data ?? Buffer.alloc(0));
    const segment = segments[depth] as string;
    const isLast = depth === segments.length - 1;
    const index = entries.findIndex((entry) => entry.name === segment);
    if (isLast) {
      if (blobOid === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '100644', name: segment, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: segment, oid: blobOid });
      }
    } else {
      const child = index >= 0 ? entries[index] : undefined;
      const childTree = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = build(childTree, depth + 1);
      if (next === null) {
        if (index >= 0) entries.splice(index, 1);
      } else if (index >= 0) {
        entries[index] = { mode: '40000', name: segment, oid: next };
      } else {
        entries.push({ mode: '40000', name: segment, oid: next });
      }
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  const result = build(rootTreeOid, 0);
  if (result === null) return putObject(repo, 'tree', buildTree([]));
  return result;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The blob oid at `path` in the tree of `commitOid`, or null. */
export function blobAtPath(repo: Repo, commitOid: string, path: string): string | null {
  const commit = getObject(repo, commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  return flat.get(path)?.oid ?? null;
}

/** The tree oid of a commit, or null. */
export function treeOf(repo: Repo, commitOid: string): string | null {
  const commit = getObject(repo, commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

// --------------------------------------------------------------------------------------------
// reachability
// --------------------------------------------------------------------------------------------

export function commitParents(repo: Repo, oid: string): string[] {
  const object = getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** All objects reachable from `roots` (commits, trees, blobs, tags). */
export function collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of commitParents(repo, oid)) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of two commits (nearest to both), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    queueA.push(...commitParents(repo, oid));
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    queueB.push(...commitParents(repo, oid));
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// diff and merge
// --------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** File-level diff between two trees (null tree = empty). */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): FileChange[] {
  const oldMap = oldTree === null ? new Map() : flattenTree(repo, oldTree);
  const newMap = newTree === null ? new Map() : flattenTree(repo, newTree);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Line counts for a blob change: additions and deletions, by common prefix/suffix. */
export function lineCounts(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldText = oldOid === null ? '' : (getObject(repo, oldOid)?.data.toString('utf8') ?? '');
  const newText = newOid === null ? '' : (getObject(repo, newOid)?.data.toString('utf8') ?? '');
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/**
 * Three-way merge of trees: base (merge-base tree), ours (base tip tree), theirs (head tip
 * tree). Returns the merged tree oid, or null when a path changed on both sides differently.
 */
export function threeWayMerge(
  repo: Repo,
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): string | null {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const ours = oursTree === null ? new Map() : flattenTree(repo, oursTree);
  const theirs = theirsTree === null ? new Map() : flattenTree(repo, theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, string>();
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (o === t) {
      if (o !== null) result.set(path, o);
    } else if (b === o) {
      if (t !== null) result.set(path, t);
    } else if (b === t) {
      if (o !== null) result.set(path, o);
    } else {
      return null; // both sides changed the path differently
    }
  }
  // Build the tree bottom-up from the flat path map.
  const build = (paths: Map<string, string>): string => {
    const root: Map<string, Map<string, string> | string> = new Map();
    for (const [path, oid] of [...paths.entries()].sort()) {
      const segments = path.split('/');
      let node: Map<string, Map<string, string> | string> = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let child = node.get(segment);
        if (child === undefined || typeof child === 'string') {
          child = new Map();
          node.set(segment, child);
        }
        node = child as Map<string, Map<string, string> | string>;
      }
      node.set(segments[segments.length - 1] as string, oid);
    }
    const buildLevel = (node: Map<string, Map<string, string> | string>): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.entries()) {
        if (typeof value === 'string') entries.push({ mode: '100644', name, oid: value });
        else entries.push({ mode: '40000', name, oid: buildLevel(value) });
      }
      return putObject(repo, 'tree', buildTree(entries));
    };
    return buildLevel(root);
  };
  if (result.size === 0) {
    // An empty tree is still a tree object.
    return putObject(repo, 'tree', buildTree([]));
  }
  return build(result);
}

export function refTarget(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function resolveBranch(repo: Repo, branch: string): string | undefined {
  if (branch.startsWith('refs/')) return repo.refs.get(branch);
  return repo.refs.get(`refs/heads/${branch}`);
}

export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs.entries()) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function commitsFrom(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

export { ZERO_OID };
