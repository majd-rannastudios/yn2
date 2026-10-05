import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Persistence.
//
// The whole event is small enough to hold in memory and snapshot as one blob,
// so that is exactly what we do. Postgres when DATABASE_URL is set (on Railway,
// reference the database service's variable), a local JSON file otherwise, so
// `npm start` needs no setup.
//
// Writes are debounced: a room of 300 people heartbeating is a lot of churn
// and none of it needs to hit disk immediately. What matters is that a crash
// or redeploy mid-event loses seconds, not the event.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 2000;
const RETRY_MS = 15_000;
const FILE = path.join(process.cwd(), 'data', 'state.json');

let driver = null;
let pending = null;
let lastSnapshot = null;
let timer = null;
let retry = null;
let degraded = false;

/**
 * Whether to negotiate TLS for a given Postgres URL.
 *
 * Private networks do not speak TLS and will hang up on a client that insists:
 * Railway's `*.railway.internal` addresses are already an isolated network, and
 * a local database has nothing to protect. Anything reached over the public
 * internet gets TLS. `PGSSLMODE` overrides the guess either way.
 */
function wantsSsl(connectionString) {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };

  let host = '';
  try { host = new URL(connectionString).hostname; } catch { return false; }

  const isPrivate =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.internal') ||
    host.endsWith('.local');

  return isPrivate ? false : { rejectUnauthorized: false };
}

/** Try to stand up the Postgres driver. Returns true if it took. */
async function tryPostgres() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: wantsSsl(process.env.DATABASE_URL)
  });
  // A real round-trip, so a URL that resolves but cannot serve still fails here.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_state (
      id         int PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  pool.on('error', err => console.error('[store] pool error:', err.message));

  driver = {
    name: 'postgres',
    async load() {
      const { rows } = await pool.query('SELECT data FROM event_state WHERE id = 1');
      return rows[0]?.data ?? null;
    },
    async save(snapshot) {
      await pool.query(
        `INSERT INTO event_state (id, data, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
        [snapshot]
      );
    }
  };
  return true;
}

function useFileDriver() {
  driver = {
    name: 'file',
    async load() {
      try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(snapshot) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      // Write-then-rename, so a crash mid-write cannot leave a truncated file.
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, FILE);
    }
  };
}

/**
 * Keep trying Postgres in the background.
 *
 * A database that is merely slow to wake - both services restarting together
 * on a redeploy, say - should not condemn the whole event to ephemeral storage
 * until someone notices and redeploys. When it comes back we switch over and
 * immediately write what is in memory, so nothing that happened in the gap is
 * lost.
 */
function scheduleRetry() {
  if (retry) return;
  retry = setInterval(async () => {
    try {
      await tryPostgres();
      clearInterval(retry);
      retry = null;
      degraded = false;
      console.log('[store] postgres reachable again - switched over');
      if (lastSnapshot) await driver.save(lastSnapshot);
    } catch {
      // Still down. Next tick.
    }
  }, RETRY_MS);
  if (retry.unref) retry.unref();
}

export async function initStore() {
  if (process.env.DATABASE_URL) {
    try {
      await tryPostgres();
      console.log('[store] postgres');
      return driver;
    } catch (err) {
      // Falling back beats refusing to boot - an event still runs. But on a
      // platform with an ephemeral filesystem this loses the room on the next
      // redeploy, so make it impossible to miss: shouted here, flagged on
      // /health, and retried in the background until it heals.
      degraded = true;
      console.error('='.repeat(72));
      console.error('[store] DATABASE_URL is set but Postgres would not connect.');
      console.error('[store] reason:', err.message);
      console.error('[store] Serving from files meanwhile. State will NOT survive a redeploy.');
      console.error('='.repeat(72));
      scheduleRetry();
    }
  }

  useFileDriver();
  console.log('[store] file:', FILE);
  return driver;
}

export async function load() {
  if (!driver) await initStore();
  try {
    return await driver.load();
  } catch (err) {
    console.error('[store] load failed:', err.message);
    return null;
  }
}

/** Queue a snapshot. Repeated calls inside the debounce window collapse. */
export function save(snapshot) {
  pending = snapshot;
  lastSnapshot = snapshot;
  if (timer) return;
  timer = setTimeout(flush, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!pending || !driver) return;
  const snapshot = pending;
  pending = null;
  try {
    await driver.save(snapshot);
  } catch (err) {
    console.error('[store] save failed:', err.message);
  }
}

export function driverName() {
  return driver?.name ?? 'none';
}

/** True when a database was configured but we are running on files anyway. */
export function isDegraded() {
  return degraded;
}
