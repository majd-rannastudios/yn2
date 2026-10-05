import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

import { PALETTE } from './config.js';
import { mountDevSignin } from './devSignin.js';
import * as store from './store.js';
import * as state from './state.js';
import * as yarnoo from './yarnoo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const app = express();
app.use(express.json({ limit: '64kb' }));
// Static files revalidate rather than sit in a browser cache for an hour.
// `no-cache` does not mean "do not store" - the file is still cached, the
// browser just asks "changed?" first and gets a 304 when it has not. That costs
// a few bytes and buys the ability to push a fix mid-event and have every phone
// in the room pick it up on the next load. Brand art never changes, so it keeps
// a real cache lifetime.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    const longLived = /[\\/]brand[\\/]/.test(filePath);
    res.setHeader('Cache-Control', longLived ? 'public, max-age=86400' : 'no-cache');
  }
}));

// --- Yarnoo sign-in ----------------------------------------------------------

yarnoo.assertConfigured();
if (yarnoo.config.mode !== 'off' && process.env.NODE_ENV === 'production' && !process.env.PUBLIC_URL) {
  console.warn('[yarnoo] PUBLIC_URL is not set - the redirect_uri sent to Yarnoo is guessed from request headers');
}

/** This app's own origin, as guests reach it. */
const baseUrl = req => (
  process.env.PUBLIC_URL ||
  `${(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim()}://${req.get('host')}`
).replace(/\/$/, '');

const STATE_COOKIE = 'yarnoo_state';

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** Nothing about a sign-in round trip should be cached or leak in a Referer. */
const noStore = res => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

app.get('/api/config', (_req, res) => res.json(yarnoo.publicConfig()));

app.get('/auth/yarnoo/start', (req, res) => {
  noStore(res);
  if (yarnoo.config.mode === 'off') return res.redirect(303, '/');
  // Ties the answer from Yarnoo to the phone that asked for it.
  const nonce = crypto.randomBytes(18).toString('base64url');
  const secure = baseUrl(req).startsWith('https:') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${nonce}; Path=/auth/yarnoo; Max-Age=900; HttpOnly; SameSite=Lax${secure}`);
  res.redirect(303, yarnoo.signinRedirect(baseUrl(req), nonce));
});

app.get('/auth/yarnoo/callback', async (req, res) => {
  noStore(res);
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/auth/yarnoo; Max-Age=0; HttpOnly; SameSite=Lax`);
  // Failures go back to the join screen, which explains them in plain words.
  const refuse = code => res.redirect(303, `/#auth_error=${encodeURIComponent(code)}`);
  if (yarnoo.config.mode === 'off') return refuse('disabled');

  // Yarnoo may answer with a reason instead of a token (cancelled, not registered).
  if (req.query.error) return refuse(String(req.query.error).replace(/[^a-z_]/gi, '').slice(0, 40) || 'denied');

  // When both sides of the state are present they must match. A missing cookie
  // is allowed: phones routinely finish sign-in in a different browser from the
  // one that scanned the QR (an in-app browser handing off to Safari), and the
  // Yarnoo app may link straight here. Those tokens are still short-lived and
  // single use.
  const expected = readCookie(req, STATE_COOKIE);
  const returned = typeof req.query.state === 'string' ? req.query.state : '';
  if (expected && returned && expected !== returned) return refuse('state_mismatch');

  try {
    const profile = await yarnoo.verifyHandoff(req.query.token);
    const guest = state.joinYarnoo(profile);
    if (!guest) return refuse('event_ended');
    // The session token travels in the fragment: it never reaches a server
    // log or a Referer, and app.js moves it into storage and wipes the URL.
    res.redirect(303, `/#token=${guest.token}`);
  } catch (err) {
    if (err instanceof yarnoo.SignInError) {
      console.warn(`[yarnoo] sign-in refused: ${err.code} (${err.message})`);
      return refuse(err.code);
    }
    console.error('[yarnoo] sign-in failed:', err);
    refuse('unavailable');
  }
});

app.use('/auth/yarnoo/dev', express.urlencoded({ extended: false, limit: '16kb' }));
mountDevSignin(app, baseUrl);

// --- guest API -------------------------------------------------------------

app.post('/api/join', (req, res) => {
  // Members only: the door is Yarnoo sign-in, not a form anyone can fill in.
  if (yarnoo.config.mode === 'required') {
    return res.status(403).json({ error: 'Sign in with Yarnoo to join this event.' });
  }
  const { name, company, role } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (state.event.status === 'ended') {
    return res.status(409).json({ error: 'This event has finished' });
  }
  const guest = state.join({ name, company, role });
  res.json({ token: guest.token, view: state.guestView(guest) });
});

app.get('/api/me', (req, res) => {
  const guest = state.touch(req.query.token);
  if (!guest) return res.status(404).json({ error: 'unknown' });
  res.json(state.guestView(guest));
});

app.post('/api/heartbeat', (req, res) => {
  const guest = state.touch(req.body?.token);
  res.json({ ok: !!guest });
});

app.get('/api/screen', (_req, res) => res.json(state.screenView()));

// The join URL is public by definition - it is printed on the QR standee.
app.get('/api/qr', async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = base.replace(/\/$/, '');
  res.json({ url, dataUrl: await QRCode.toDataURL(url, { width: 720, margin: 1, color: { dark: '#A51374', light: '#FFFFFF' } }) });
});

// --- operator console ------------------------------------------------------

const adminTokens = new Set();

app.post('/api/admin/login', (req, res) => {
  const pin = String(req.body?.pin ?? '');
  // Constant-time-ish compare so the PIN cannot be probed by timing.
  const ok =
    pin.length === ADMIN_PIN.length &&
    crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN));
  if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.admin;
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  next();
}

app.get('/api/admin/state', requireAdmin, (_req, res) => res.json(state.adminView()));

app.post('/api/admin/config', requireAdmin, (req, res) => {
  res.json(state.configure(req.body || {}));
});

app.post('/api/admin/action', requireAdmin, (req, res) => {
  const action = req.body?.action;
  switch (action) {
    case 'start': state.start(); break;
    case 'pause': state.pause(); break;
    case 'resume': state.resume(); break;
    case 'next': state.nextRound(); break;
    case 'end': state.endEvent(); break;
    case 'reset': state.resetEvent(); break;
    case 'add-time': state.nudgeRound(60_000); break;
    case 'less-time': state.nudgeRound(-60_000); break;
    default: return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  res.json(state.adminView());
});

app.post('/api/admin/remove', requireAdmin, (req, res) => {
  res.json({ ok: state.removeGuest(req.body?.id) });
});

app.get('/api/admin/export.csv', requireAdmin, (_req, res) => {
  res.type('text/csv').attachment('guests.csv').send(state.exportCsv());
});

app.get('/api/admin/qr', requireAdmin, async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = base.replace(/\/$/, '');
  res.json({ url, dataUrl: await QRCode.toDataURL(url, { width: 720, margin: 1, color: { dark: '#A51374', light: '#FFFFFF' } }) });
});

app.get('/api/palette', (_req, res) => res.json(PALETTE));

// Railway healthcheck. Reports the store too, so a deploy that silently fell
// back to file storage is visible instead of being discovered mid-event.
app.get('/health', (_req, res) => {
  const degraded = store.isDegraded();
  res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    store: store.driverName(),
    signIn: yarnoo.config.mode,
    warning: degraded
      ? 'DATABASE_URL is set but Postgres is not connected - state will not survive a redeploy'
      : undefined,
    status: state.event.status,
    round: state.event.roundIndex,
    guests: state.participants.size,
    uptime: Math.round(process.uptime())
  });
});

// --- pages -----------------------------------------------------------------

const page = file => (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', file));
app.get('/', page('index.html'));
app.get('/admin', page('admin.html'));
app.get('/screen', page('screen.html'));

// --- realtime --------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}  (admin: /admin, projector: /screen)`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  socket.role = params.get('role') || 'guest';
  socket.token = params.get('token');
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => {});
  push(socket);
});

/** Send one socket whatever its role should be looking at. */
function push(socket) {
  if (socket.readyState !== socket.OPEN) return;
  let payload = null;
  if (socket.role === 'guest') {
    const guest = state.touch(socket.token);
    // The guest was removed, or the event was reset out from under them.
    // Close so the phone falls back to polling and re-registers.
    if (!guest) { socket.close(); return; }
    payload = { type: 'guest', data: state.guestView(guest) };
  } else if (socket.role === 'screen') {
    payload = { type: 'screen', data: state.screenView() };
  } else if (socket.role === 'admin' && adminTokens.has(socket.token)) {
    payload = { type: 'admin', data: state.adminView() };
  }
  if (payload) socket.send(JSON.stringify(payload));
}

// Any change to the event fans out to every connected screen and phone.
state.onChange(() => {
  for (const socket of wss.clients) push(socket);
});

// Drop sockets that stopped answering, so the client falls back to polling.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) { socket.terminate(); continue; }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

// The round clock. One second is plenty; the phones run their own countdown
// off roundEndsAt and only need the server for the moment it flips.
const clock = setInterval(() => { state.tick(); }, 1000);
clock.unref();

// --- boot ------------------------------------------------------------------

await store.initStore();
const saved = await store.load();
if (saved) state.hydrate(saved);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n[server] ${signal} - saving`);
    await store.flush();
    process.exit(0);
  });
}
