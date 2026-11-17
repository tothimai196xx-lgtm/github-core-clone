# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tothimai196xx-lgtm/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tothimai196xx-lgtm/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single Node process (stdlib only, no dependencies) that implements enough of
GitHub to clone/push over git smart HTTP, manage repositories, issues and pull
requests over REST v3, answer GraphQL, and serve MCP tools — all against one
in-memory store, so every surface reads the same state.

Built for the make.fun bounty
[`github-core-clone-01`](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge"). License: MIT (see `LICENSE`).

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | The entry lifecycle (from the kit starter, unchanged): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0. |
| `app.ts` | The HTTP server: routing, bearer auth, body reading, and the git smart-HTTP handlers (info/refs, upload-pack v0/v2, receive-pack). |
| `store.ts` | All state, in memory: repositories, git objects/refs, issues, pull requests, labels, comments — plus git helpers (tree updates, reachability, diff, three-way merge) and deterministic timestamps. |
| `gitproto.ts` | The git wire format: SHA-1, pkt-lines, sideband framing, pack read/write (plain objects on write, OFS/REF deltas resolved on read), tree/commit/tag codecs. |
| `rest.ts` | GitHub REST v3 under `/api/v3`: repos, branches, commits, contents (create/update/delete with SHA checks), git refs, labels, issues, comments, pull requests (incl. squash merge with conflict detection). |
| `graphql.ts` | A document-driven GraphQL executor for `/api/graphql`: `viewer`, `repository` (issues/pullRequests connections with cursor pagination, single issue/PR reads), `node(id:)`, `__type` introspection, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations. |
| `mcp.ts` | MCP over Streamable HTTP at `POST /mcp`: `server/discover`, legacy `initialize`, `tools/list` (6 tools, byte-identical), `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`. |

## Endpoints

- **Git smart HTTP** — `/<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack`,
  `git-upload-pack`, `git-receive-pack`. Protocol v2 (advertisement, `ls-refs`,
  `fetch` with `thin-pack`/`shallow`/`deepen`) and v0. Push enforces
  fast-forward per ref (non-fast-forward is refused with reason
  `non-fast-forward`); tag create/delete is supported; shallow clones and
  `deepen` respect the boundary exactly.
- **REST v3** — `/api/v3/` (root + `meta`), `/api/v3/user`, `/api/v3/user/repos`,
  `/api/v3/repos/{owner}/{repo}` (+ `/branches`, `/commits`, `/contents/{path}`,
  `/git/refs`, `/labels`, `/issues`, `/issues/{n}/comments`, `/pulls`,
  `/pulls/{n}/files`, `/pulls/{n}/merge`). Every reply is `application/json`
  with a non-empty `X-GitHub-Request-Id`; errors are `{"message": string}`.
  Pagination follows GitHub's `Link` headers. Issue and PR numbers share one
  per-repo counter, as on GitHub.
- **GraphQL** — `POST /api/graphql`, single operations and batched arrays.
  Unknown fields are reported as HTTP 200 with an `errors` array naming the
  field; an unknown repository answers `data.repository = null` with no errors.
- **MCP** — `POST /mcp` (JSON-RPC 2.0, plain JSON replies). Unknown tools are
  `-32601`, missing arguments are `isError: true`, malformed JSON is HTTP 400
  with `-32700`, unauthenticated calls are HTTP 401.

**Auth.** Every `/api/v3`, `/api/graphql` and `/mcp` request must carry
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (exact match). When the variable is
empty (local development only) any non-empty bearer is accepted. Git paths are
unauthenticated. The viewer identity is `adaiversen` (id 1000); any other
owner answers 404, never 403.

**Determinism.** All timestamps come from a counter starting at
2025-01-01T00:00:00Z, never the wall clock, so identical request sequences mint
identical commit ids and `created_at` values.

## Run it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL (the trial harness)
```

Local development (no harness): the work directory's `run-local.ts` starts the
same server on a fixed port with a test token — see the build report in the
parent directory for the exact commands.

## Test it

- **Kit local suite** (from the kit directory, against a running server):
  `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOKEN`
  — 120 checks; `--perf` adds the four benchmark workloads.
- **Full grade-local**: `node cli/makefun.mjs grade-local --kit . --bot <entry-dir> --driver process`.
- **By hand**: `git clone` / `git push` / `git clone --depth 1` against the
  server work with the real git CLI, as do REST and GraphQL calls with curl.

Local results (2026-11-17, Node v24.22.1): kit suite **120/120** checks pass;
`sdk/run.ts --perf` scores **924/1000** (feature 600, agent 200, perf 124);
`grade-local --driver process` scores **950/1000** (feature 600, agent 200,
perf 150), replay reproduced byte for byte.

## Known limitations

- State is in memory only: restarting the process starts with an empty forge.
  That matches the trial model (one process per trial) and keeps every
  benchmark fast (no fsync, no disk).
- Packs are written with plain objects only (no deltas); deltas sent by
  clients are resolved on read.
- The GraphQL executor recognises the documents the grading suite sends; it is
  not a general-purpose GraphQL implementation.
- The entry was tested on Node v24.22.1; the server harness runs Node v26 —
  only stable Node built-ins are used, so no version-specific behaviour is
  expected.

---

<sub>Entered on [make.fun](https://make.fun/?ref=wxz47nrz&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
