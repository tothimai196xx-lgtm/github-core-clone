// rest.ts — GitHub REST v3 under /api/v3. Every reply is application/json, carries a
// non-empty X-GitHub-Request-Id, and errors carry {message: string}. Auth is a bearer
// token equal to MAKEFUN_SHOP_TOKEN; without it every route is 401.

import {
  blobAtPath,
  commitsFrom,
  createCommit,
  createTagObject,
  diffTrees,
  flattenTree,
  getObject,
  lineCounts,
  listBranches,
  mergeBase,
  putObject,
  refTarget,
  resolveBranch,
  setPath,
  threeWayMerge,
  treeOf,
  VIEWER,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { parseCommit } from './gitproto.ts';

export interface RestContext {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or undefined when there is none
  bodyText: string;
  host: string; // request Host header, for absolute pagination links
  authed: boolean;
  requestId: string;
}

export interface RestResponder {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function respond(status: number, value: unknown, extra: Record<string, string> = {}): RestResponder {
  const body = value === null ? '' : `${JSON.stringify(value)}\n`;
  return { status, headers: { 'content-type': JSON_TYPE, ...extra }, body };
}

function err(status: number, message: string): RestResponder {
  return respond(status, { message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : repo.id, type: 'User' };
  return {
    id: repo.id,
    node_id: Buffer.from(`R:${repo.owner}/${repo.name}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(1735689600 * 1000 + repo.createdSeq * 1000).toISOString(),
    updated_at: new Date(1735689600 * 1000 + repo.createdSeq * 1000).toISOString(),
    pushed_at: new Date(1735689600 * 1000 + repo.createdSeq * 1000).toISOString(),
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: '', name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`I:${repo.owner}/${repo.name}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map(labelJson),
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const merged = pull.merged;
  return {
    id: pull.id,
    node_id: Buffer.from(`P:${repo.owner}/${repo.name}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      repo: repoJson(store, repo),
    },
    merged,
    mergeable: mergeableState(store, repo, pull) !== 'CONFLICTING',
    mergeable_state: mergeableState(store, repo, pull) === 'CONFLICTING' ? 'dirty' : 'clean',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** MERGEABLE / CONFLICTING for a pull request, by three-way merge of its trees. */
export function mergeableState(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const headTip = resolveBranch(repo, pull.headRef);
  const baseTip = resolveBranch(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  const base = mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
  const merged = threeWayMerge(repo, treeOf(repo, base), treeOf(repo, baseTip), treeOf(repo, headTip));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = getObject(repo, sha);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const author = parseAuthorLine(view.author);
  const committer = parseAuthorLine(view.committer);
  return {
    sha,
    node_id: Buffer.from(`C:${repo.owner}/${repo.name}:${sha}`, 'utf8').toString('base64'),
    commit: {
      message: view.message.replace(/\n+$/, ''),
      author,
      committer,
      tree: { sha: view.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(ctx: RestContext, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const build = (p: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `<http://${ctx.host}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(build(page + 1, 'next'));
  if (totalPages > 1) parts.push(build(totalPages, 'last'));
  if (page > 1) {
    parts.push(build(1, 'first'));
    parts.push(build(page - 1, 'prev'));
  }
  return parts.join(', ');
}

/** Look a repository up; the token's owner is the viewer, any other owner is a 404. */
function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

export function handleRest(store: Store, ctx: RestContext): RestResponder {
  if (!ctx.authed) return err(401, 'Requires authentication');
  const seg = ctx.segments;
  const method = ctx.method;

  // The API root and meta.
  if (seg.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return respond(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return respond(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return respond(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: Buffer.from(`U:${VIEWER.login}`, 'utf8').toString('base64'),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }

  // POST /user/repos and GET /user/repos.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') return createRepoRoute(store, ctx);
    if (method === 'GET') return listUserReposRoute(store, ctx);
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1] as string);
    const name = decodeURIComponent(seg[2] as string);
    const rest = seg.slice(3);
    return handleRepoRoute(store, ctx, owner, name, rest);
  }

  return err(404, 'Not Found');
}

function parseBody(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.body === undefined) return {};
  if (!isRecord(ctx.body)) return null;
  return ctx.body;
}

function createRepoRoute(store: Store, ctx: RestContext): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') return err(422, 'Repository name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
    return err(422, 'Invalid repository name');
  }
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    return err(422, `Repository ${VIEWER.login}/${name} already exists`);
  }
  const repo = store.createRepo(
    VIEWER.login,
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  );
  return respond(201, repoJson(store, repo));
}

function listUserReposRoute(store: Store, ctx: RestContext): RestResponder {
  const { page, perPage } = pageParams(ctx.query);
  const repos = store.listViewerRepos();
  const { items, hasNext, totalPages } = paginate(repos, page, perPage);
  const extra: Record<string, string> = {};
  if (hasNext || totalPages > 1) {
    extra.link = linkHeader(ctx, '/api/v3/user/repos', ctx.query, page, perPage, totalPages);
  }
  return respond(200, items.map((repo) => repoJson(store, repo)), extra);
}

function handleRepoRoute(store: Store, ctx: RestContext, owner: string, name: string, rest: string[]): RestResponder {
  const method = ctx.method;
  const repo = lookupRepo(store, owner, name);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === null) return err(404, 'Not Found');
      return respond(200, repoJson(store, repo));
    }
    if (method === 'PATCH') {
      if (repo === null) return err(404, 'Not Found');
      const body = parseBody(ctx);
      if (body === null) return err(400, 'Invalid JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return respond(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      if (repo === null) return err(404, 'Not Found');
      store.deleteRepo(owner, name);
      return { status: 204, headers: { 'content-type': JSON_TYPE }, body: '' };
    }
    return err(404, 'Not Found');
  }

  if (repo === null) return err(404, 'Not Found');
  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      return respond(
        200,
        listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha },
          protected: false,
        })),
      );
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1] as string);
      const sha = resolveBranch(repo, branch);
      if (sha === undefined) return err(404, 'Not Found');
      return respond(200, { name: branch, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (head === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return err(404, 'Not Found');
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null || shaParam === '') tip = resolveBranch(repo, repo.defaultBranch);
    else if (/^[0-9a-f]{40}$/.test(shaParam)) tip = shaParam;
    else tip = resolveBranch(repo, shaParam);
    if (tip === undefined) return respond(200, []);
    const { page, perPage } = pageParams(ctx.query);
    const all = commitsFrom(repo, tip)
      .map((sha) => commitJson(store, repo, sha))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const { items } = paginate(all, page, perPage);
    return respond(200, items);
  }

  if (head === 'contents') {
    const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    if (method === 'GET') return getContentsRoute(store, ctx, repo, path);
    if (method === 'PUT') return putContentsRoute(store, ctx, repo, path);
    if (method === 'DELETE') return deleteContentsRoute(store, ctx, repo, path);
    return err(404, 'Not Found');
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) return createRefRoute(store, ctx, repo);
    if (method === 'GET' && rest.length === 2) {
      const refs: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        refs.push({ ref, object: { sha, type: 'commit' } });
      }
      return respond(200, refs);
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/');
      const full = `refs/${ref}`;
      const sha = refTarget(repo, full);
      if (sha === undefined) return err(404, 'Not Found');
      return respond(200, { ref: full, object: { sha, type: 'commit' } });
    }
    return err(404, 'Not Found');
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return respond(200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'POST' && rest.length === 1) {
      const body = parseBody(ctx);
      if (body === null) return err(400, 'Invalid JSON');
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') return err(422, 'Label name is required');
      const existing = repo.labels.get(labelName);
      if (existing !== undefined) return respond(201, labelJson(existing));
      const label: Label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(labelName, label);
      return respond(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssueRoute(store, ctx, repo);
      if (method === 'GET') return listIssuesRoute(store, ctx, repo);
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        const issue = repo.issues.get(number);
        if (issue === undefined) return err(404, 'Not Found');
        return respond(200, issueJson(store, repo, issue));
      }
      if (method === 'PATCH') {
        const issue = repo.issues.get(number);
        if (issue === undefined) return err(404, 'Not Found');
        const body = parseBody(ctx);
        if (body === null) return err(400, 'Invalid JSON');
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        issue.updatedAt = store.nowIso();
        return respond(200, issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') return createCommentRoute(store, ctx, repo, number);
      if (method === 'GET') {
        if (!repo.issues.has(number)) return err(404, 'Not Found');
        const comments = repo.comments.get(number) ?? [];
        return respond(
          200,
          comments.map((comment) => ({
            id: comment.id,
            node_id: Buffer.from(`C:${repo.owner}/${repo.name}:${number}:${comment.id}`, 'utf8').toString('base64'),
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
          })),
        );
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPullRoute(store, ctx, repo);
      if (method === 'GET') return listPullsRoute(store, ctx, repo);
      return err(404, 'Not Found');
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') {
        const pull = repo.pulls.get(number);
        if (pull === undefined) return err(404, 'Not Found');
        return respond(200, pullJson(store, repo, pull));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return listPullFilesRoute(store, repo, number);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      return mergePullRoute(store, ctx, repo, number);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// --------------------------------------------------------------------------------------------
// contents
// --------------------------------------------------------------------------------------------

function resolveRefTip(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return resolveBranch(repo, repo.defaultBranch);
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  return resolveBranch(repo, ref);
}

function getContentsRoute(store: Store, ctx: RestContext, repo: Repo, path: string): RestResponder {
  const tip = resolveRefTip(repo, ctx.query.get('ref'));
  if (tip === undefined) return err(404, 'Not Found');
  const tree = treeOf(repo, tip);
  if (tree === null) return err(404, 'Not Found');
  const flat = flattenTree(repo, tree);
  if (path === '') {
    // The repository root: list its top-level entries.
    const entries = new Map<string, { type: string; oid: string }>();
    for (const [filePath, entry] of flat.entries()) {
      const first = filePath.split('/')[0] as string;
      if (!entries.has(first)) {
        entries.set(first, { type: filePath.includes('/') ? 'dir' : 'file', oid: entry.oid });
      }
    }
    const out: Array<Record<string, unknown>> = [];
    for (const [name, entry] of [...entries.entries()].sort()) {
      out.push({ type: entry.type, name, path: name, sha: entry.oid, size: entry.type === 'file' ? (getObject(repo, entry.oid)?.data.length ?? 0) : 0 });
    }
    return respond(200, out);
  }
  const file = flat.get(path);
  if (file !== undefined) {
    const object = getObject(repo, file.oid);
    if (object === undefined) return err(404, 'Not Found');
    const name = path.split('/').pop() as string;
    return respond(200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name,
      path,
      content: object.data.toString('base64'),
      sha: file.oid,
    });
  }
  // A directory: its immediate children.
  const prefix = `${path}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [filePath, entry] of flat.entries()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const first = rest.split('/')[0] as string;
    if (children.has(first)) continue;
    const isDir = rest.includes('/');
    children.set(first, {
      type: isDir ? 'dir' : 'file',
      oid: entry.oid,
      size: isDir ? 0 : (getObject(repo, entry.oid)?.data.length ?? 0),
    });
  }
  if (children.size === 0) return err(404, 'Not Found');
  const out: Array<Record<string, unknown>> = [];
  for (const [name, entry] of [...children.entries()].sort()) {
    out.push({ type: entry.type, name, path: `${path}/${name}`, sha: entry.oid, size: entry.size });
  }
  return respond(200, out);
}

function putContentsRoute(store: Store, ctx: RestContext, repo: Repo, path: string): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  if (typeof body.message !== 'string' || typeof body.content !== 'string') {
    return err(422, 'message and content are required');
  }
  let content: Buffer;
  try {
    content = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = resolveBranch(repo, branch);
  if (tip === undefined) {
    // The branch does not exist yet: start it at the default branch tip (or unborn).
    const defaultTip = resolveBranch(repo, repo.defaultBranch);
    if (defaultTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const currentTree = tip === undefined ? null : treeOf(repo, tip);
  const currentBlob = tip === undefined ? null : blobAtPath(repo, tip, path);
  const isUpdate = currentBlob !== null;
  if (isUpdate && body.sha === undefined) return err(422, 'sha is required to update a file');
  if (typeof body.sha === 'string' && body.sha !== '' && currentBlob !== body.sha) {
    return err(409, 'sha does not match the current file');
  }
  if (!isUpdate && typeof body.sha === 'string' && body.sha !== '') {
    return err(409, 'sha does not match the current file');
  }
  const blobOid = putObject(repo, 'blob', content);
  const newTree = setPath(repo, currentTree, path, blobOid);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = createCommit(store, repo, newTree, parents, body.message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  const name = path.split('/').pop() as string;
  return respond(isUpdate ? 200 : 201, {
    content: {
      name,
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitSha, message: body.message },
  });
}

function deleteContentsRoute(store: Store, ctx: RestContext, repo: Repo, path: string): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  if (typeof body.message !== 'string') return err(422, 'message is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = resolveBranch(repo, branch);
  if (tip === undefined) return err(404, 'Not Found');
  const currentBlob = blobAtPath(repo, tip, path);
  if (currentBlob === null) return err(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== currentBlob) {
    return err(409, 'sha does not match the current file');
  }
  const currentTree = treeOf(repo, tip);
  if (currentTree === null) return err(404, 'Not Found');
  const newTree = setPath(repo, currentTree, path, null);
  const commitSha = createCommit(store, repo, newTree, [tip], body.message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return respond(200, { commit: { sha: commitSha, message: body.message } });
}

// --------------------------------------------------------------------------------------------
// git refs
// --------------------------------------------------------------------------------------------

function createRefRoute(store: Store, ctx: RestContext, repo: Repo): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
    return err(422, 'ref and sha are required');
  }
  if (getObject(repo, sha) === undefined) return err(422, 'sha does not exist');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  repo.refs.set(ref, sha);
  return respond(201, { ref, object: { sha, type: 'commit' } });
}

// --------------------------------------------------------------------------------------------
// issues
// --------------------------------------------------------------------------------------------

function createIssueRoute(store: Store, ctx: RestContext, repo: Repo): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return err(422, 'title is required');
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      if (typeof entry !== 'string') continue;
      const label = repo.labels.get(entry);
      if (label === undefined) return err(422, `Label does not exist: ${entry}`);
      labels.push(label);
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = store.nowIso();
  const issue: Issue = {
    number,
    id: store.nextId,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    seq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  store.nextId += 1;
  repo.issues.set(number, issue);
  return respond(201, issueJson(store, repo, issue));
}

function listIssuesRoute(store: Store, ctx: RestContext, repo: Repo): RestResponder {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    issues.sort((a, b) => b.seq - a.seq);
  }
  const { page, perPage } = pageParams(ctx.query);
  const { items, hasNext, totalPages } = paginate(issues, page, perPage);
  const extra: Record<string, string> = {};
  if (hasNext || totalPages > 1) {
    extra.link = linkHeader(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.query, page, perPage, totalPages);
  }
  return respond(200, items.map((issue) => issueJson(store, repo, issue)), extra);
}

function createCommentRoute(store: Store, ctx: RestContext, repo: Repo, number: number): RestResponder {
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  if (typeof body.body !== 'string' || body.body === '') return err(422, 'body is required');
  const id = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment = { id, body: body.body, seq: store.nextSeq(), createdAt: store.nowIso() };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  issue.updatedAt = store.nowIso();
  return respond(201, {
    id: comment.id,
    node_id: Buffer.from(`C:${repo.owner}/${repo.name}:${number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  });
}

// --------------------------------------------------------------------------------------------
// pull requests
// --------------------------------------------------------------------------------------------

function createPullRoute(store: Store, ctx: RestContext, repo: Repo): RestResponder {
  const body = parseBody(ctx);
  if (body === null) return err(400, 'Invalid JSON');
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') return err(422, 'title and head are required');
  const headSha = resolveBranch(repo, head);
  const baseSha = resolveBranch(repo, base);
  if (headSha === undefined) return err(422, `head branch ${head} does not exist`);
  if (baseSha === undefined) return err(422, `base branch ${base} does not exist`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head) {
      return err(422, 'A pull request already exists for this head branch');
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = store.nowIso();
  const pull: Pull = {
    number,
    id: store.nextId,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  store.nextId += 1;
  repo.pulls.set(number, pull);
  return respond(201, pullJson(store, repo, pull));
}

function listPullsRoute(store: Store, ctx: RestContext, repo: Repo): RestResponder {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, perPage } = pageParams(ctx.query);
  const { items, hasNext, totalPages } = paginate(pulls, page, perPage);
  const extra: Record<string, string> = {};
  if (hasNext || totalPages > 1) {
    extra.link = linkHeader(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.query, page, perPage, totalPages);
  }
  return respond(200, items.map((pull) => pullJson(store, repo, pull)), extra);
}

function listPullFilesRoute(store: Store, repo: Repo, number: number): RestResponder {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');
  const changes = diffTrees(repo, treeOf(repo, pull.baseSha), treeOf(repo, pull.headSha));
  const out = changes.map((change) => {
    const counts = lineCounts(repo, change.oldOid, change.newOid);
    return {
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
  return respond(200, out);
}

function mergePullRoute(store: Store, ctx: RestContext, repo: Repo, number: number): RestResponder {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');
  if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already closed');
  const headTip = resolveBranch(repo, pull.headRef);
  const baseTip = resolveBranch(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return err(405, 'Head or base branch is missing');
  const base = mergeBase(repo, headTip, baseTip) ?? pull.baseSha;
  const mergedTree = threeWayMerge(repo, treeOf(repo, base), treeOf(repo, baseTip), treeOf(repo, headTip));
  if (mergedTree === null) return err(405, 'Merge conflict');
  const message = `Merge pull request #${number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
  const mergeSha = createCommit(store, repo, mergedTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = store.nowIso();
  return respond(200, { sha: mergeSha, merged: true, message });
}

export { createTagObject };
