// main.ts — the trial entrypoint for the git forge.
//
// How a trial runs, from the harness side: the suite (the grading program
// that shares this trial's pod) needs to find the forge, drive it, and know
// when it may stop. This file is the small piece of glue that makes that
// handshake happen:
//
//   1. Build the forge (the HTTP server from app.ts) and bind it to a port
//      the kernel picks for us, so we never clash with the suite's own
//      listener on 8080.
//   2. Tell the suite which port we picked: POST {"port": <port>} to
//      $MAKEFUN_ENV_URL/register. The suite notes the address that request
//      came from and talks to the forge there.
//   3. Wait while the suite runs its checks and workloads, asking
//      GET $MAKEFUN_ENV_URL/done over and over. The suite keeps answering
//      {"done": false} until it has finished and written its export, and
//      only then answers {"done": true}.
//   4. On that answer, stop serving and leave with exit code 0.
//
// Nothing here reaches past the suite: no outside network, no clock in any
// request, no randomness. Node standard library only; launched as
// `node --experimental-strip-types main.ts`.

import { createApp } from './app.ts';

// The two harness endpoints, relative to $MAKEFUN_ENV_URL.
const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

// How long to rest between "are you done yet?" asks, and how stubbornly to
// retry the one-shot registration before giving up on the trial.
const POLL_GAP_MS = 1000;
const REGISTER_ATTEMPTS = 10;
const REGISTER_GAP_MS = 500;

/** The harness origin, or a loud failure when the trial did not set it. */
function harnessBase(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set; the trial harness must provide it');
  }
  return raw.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function note(message: string): void {
  process.stderr.write(`[forge] ${message}\n`);
}

/** Start `server` on a kernel-chosen port and report the port it got. */
function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

/**
 * Hand the suite our port. A single failed attempt is not worth losing the
 * trial over — the suite may still be coming up — so retry a few times
 * before admitting defeat.
 */
async function announcePort(base: string, port: number): Promise<void> {
  const target = `${base}${REGISTER_PATH}`;
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (!response.ok) {
        throw new Error(`the suite answered HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastFailure = error;
      const reason = error instanceof Error ? error.message : String(error);
      note(`register attempt ${attempt} of ${REGISTER_ATTEMPTS} failed (${reason}); retrying`);
      await sleep(REGISTER_GAP_MS);
    }
  }
  throw lastFailure;
}

/**
 * Ask the suite, again and again, whether it has finished. Any single ask
 * may fail or come back "not yet" — only an answer of {"done": true} ends
 * the wait, so a hiccup just means asking again after a short rest.
 */
async function waitForSuite(base: string): Promise<void> {
  const target = `${base}${DONE_PATH}`;
  for (;;) {
    try {
      const response = await fetch(target);
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      } else {
        note(`done check answered HTTP ${response.status}; asking again`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      note(`done check failed (${reason}); asking again`);
    }
    await sleep(POLL_GAP_MS);
  }
}

/** Stop accepting new work, then drop any lingering keep-alive sockets. */
function stopServing(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 2000).unref();
  });
}

async function run(): Promise<void> {
  const base = harnessBase();
  const forge = createApp();
  const port = await bindEphemeral(forge);
  note(`forge listening on port ${port}`);
  await announcePort(base, port);
  note('registered with the suite; waiting for it to finish');
  await waitForSuite(base);
  note('suite finished; shutting down');
  await stopServing(forge);
}

run().then(
  () => process.exit(0),
  (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[forge] fatal: ${reason}\n`);
    process.exit(1);
  },
);
