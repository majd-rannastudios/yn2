// End-to-end checks for Sign in with Yarnoo. Boots its own servers with known
// settings, plays Yarnoo's side of the handoff, and tries the ways it should
// fail: forged, expired, replayed, wrong audience, wrong event, crossed state.
//
//   npm run e2e:yarnoo

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
const ISSUER = 'https://yarnoo.test';
const EVENT = 'community-night';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fails = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail && !cond ? '  — ' + detail : ''}`);
  if (!cond) fails++;
};

const servers = [];
async function boot(port, env, { expectExit = false, snapshot = null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stw-yarnoo-'));
  if (snapshot) {
    fs.mkdirSync(path.join(cwd, 'data'));
    fs.writeFileSync(path.join(cwd, 'data', 'state.json'), JSON.stringify(snapshot));
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd,
    env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'development', PUBLIC_URL: '', ADMIN_PIN: '1234', PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  servers.push(child);
  if (expectExit) return { code: await Promise.race([exited, sleep(5000).then(() => 'still running')]), log: () => log };
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://localhost:${port}/health`); return { base: `http://localhost:${port}`, log: () => log }; } catch {}
    await sleep(100);
  }
  throw new Error(`server on ${port} did not start:\n${log}`);
}

const mint = (claims = {}, { secret = SECRET, issuer = ISSUER, audience = 'spin-the-wheel', exp = '5m', iat, jti = true } = {}) => {
  let jwt = new SignJWT({ name: 'Layla Haddad', role: 'Singer', company: 'Stage Nine', event: EVENT, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub ?? 'u-100')
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp);
  if (jti) jwt = jwt.setJti(crypto.randomUUID());
  return jwt.sign(new TextEncoder().encode(secret));
};

/** Follow the callback by hand and report where it sends the phone. */
async function callback(base, token, { state, cookie } = {}) {
  const url = new URL('/auth/yarnoo/callback', base);
  if (token) url.searchParams.set('token', token);
  if (state) url.searchParams.set('state', state);
  const res = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const location = res.headers.get('location') || '';
  const frag = new URLSearchParams(location.split('#')[1] || '');
  return { status: res.status, location, token: frag.get('token'), error: frag.get('auth_error') };
}

const json = (base, p, opts) => fetch(base + p, opts).then(r => r.json());
const adminToken = async base => (await json(base, '/api/admin/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '1234' })
})).token;
const admin = (base, tok, p, body) => json(base, p, {
  method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json', 'x-admin-token': tok },
  body: body ? JSON.stringify(body) : undefined
});

try {
  // --- a members-only event ----------------------------------------------
  const A = await boot(3311, {
    YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect',
    YARNOO_JWT_SECRET: SECRET,
    YARNOO_JWT_ISSUER: ISSUER,
    YARNOO_EVENT_ID: EVENT
  });
  const base = A.base;

  const cfg = await json(base, '/api/config');
  check('configured sign-in defaults to members only', cfg.auth === 'required', JSON.stringify(cfg));
  const health = await json(base, '/health');
  check('/health reports the sign-in mode', health.signIn === 'required');

  const walkIn = await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Gatecrasher' }) });
  check('the anonymous form is closed when sign-in is required', walkIn.status === 403);

  const start = await fetch(base + '/auth/yarnoo/start', { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  const cookie = (start.headers.get('set-cookie') || '').split(';')[0];
  check('start redirects to Yarnoo sign-in', start.status === 303 && to.origin + to.pathname === 'https://yarnoo.test/connect');
  check('start sends redirect_uri, state, audience and event',
    to.searchParams.get('redirect_uri') === `${base}/auth/yarnoo/callback` && !!to.searchParams.get('state') &&
    to.searchParams.get('audience') === 'spin-the-wheel' && to.searchParams.get('event') === EVENT, to.href);
  check('start sets an HttpOnly state cookie', /HttpOnly/i.test(start.headers.get('set-cookie') || '') && cookie.startsWith('yarnoo_state='));
  check('start is never cached', start.headers.get('cache-control') === 'no-store');

  const state = to.searchParams.get('state');
  const first = await callback(base, await mint({ sub: 'u-100', picture: 'https://cdn.yarnoo.test/u100.jpg', profile_url: 'https://yarnoo.test/u/layla' }), { state, cookie });
  check('a valid token seats the member and hands the session over in the fragment', first.status === 303 && !!first.token, first.location);

  const me = await json(base, `/api/me?token=${first.token}`);
  check('the guest is the Yarnoo profile', me.me?.name === 'Layla Haddad' && me.me?.yarnoo === true && me.me?.avatarUrl === 'https://cdn.yarnoo.test/u100.jpg', JSON.stringify(me.me));

  const again = await callback(base, await mint({ sub: 'u-100', name: 'Layla H.' }));
  check('signing in again returns the same seat, not a second guest', again.token === first.token, again.location);
  const tok = await adminToken(base);
  let st = await admin(base, tok, '/api/admin/state');
  check('one profile is one guest', st.guests.filter(g => g.yarnooId === 'u-100').length === 1 && st.guests.length === 1);
  check('a second sign-in refreshes the profile', st.guests[0].name === 'Layla H.');

  const once = await mint({ sub: 'u-101' });
  await callback(base, once);
  const replay = await callback(base, once);
  check('a token works once', replay.error === 'already_used', replay.location);

  const expired = await callback(base, await mint({ sub: 'u-102' }, { iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 1800 }));
  check('an expired token is refused as expired', expired.error === 'expired', expired.location);
  const stale = await callback(base, await mint({ sub: 'u-102' }, { iat: Math.floor(Date.now() / 1000) - 1800, exp: '1h' }));
  check('a long-lived token issued 30 minutes ago is refused', stale.error === 'expired', stale.location);

  const forged = await callback(base, await mint({ sub: 'u-103' }, { secret: 'some-other-secret-that-is-also-long-enough-000' }));
  check('a token signed with another key is refused', forged.error === 'invalid_token', forged.location);
  const wrongAud = await callback(base, await mint({ sub: 'u-104' }, { audience: 'some-other-app' }));
  check('a token for another app is refused', wrongAud.error === 'invalid_token', wrongAud.location);
  const wrongIss = await callback(base, await mint({ sub: 'u-105' }, { issuer: 'https://evil.test' }));
  check('a token from another issuer is refused', wrongIss.error === 'invalid_token', wrongIss.location);

  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u-106', iss: ISSUER, aud: 'spin-the-wheel', iat: now, exp: now + 300, event: EVENT })}.`;
  const unsigned = await callback(base, none);
  check('an unsigned (alg: none) token is refused', unsigned.error === 'invalid_token', unsigned.location);

  const noJti = await callback(base, await mint({ sub: 'u-111' }, { jti: false }));
  check('a token without a jti is refused - every token is single use', noJti.error === 'invalid_token', noJti.location);
  const dots = await callback(base, await mint({ sub: '..' }));
  check('a member id of ".." is refused', dots.error === 'invalid_token', dots.location);

  const notRegistered = await callback(base, await mint({ sub: 'u-107', event: 'another-event' }));
  check('a member not registered for this event is refused', notRegistered.error === 'not_registered', notRegistered.location);
  const viaList = await callback(base, await mint({ sub: 'u-108', event: undefined, events: ['x', EVENT] }));
  check('registration can arrive as an events list', !!viaList.token, viaList.location);

  const crossed = await callback(base, await mint({ sub: 'u-109' }), { state: 'not-the-one', cookie });
  check('a crossed state is refused', crossed.error === 'state_mismatch', crossed.location);
  const deny = await fetch(new URL('/auth/yarnoo/callback?error=access_denied', base), { redirect: 'manual' });
  check('Yarnoo can send back a reason instead of a token', (deny.headers.get('location') || '').endsWith('#auth_error=access_denied'));
  const noToken = await callback(base, null);
  check('a callback with no token is refused', noToken.error === 'missing_token', noToken.location);

  const hostile = await callback(base, await mint({ sub: 'u-110', name: '<img src=x onerror=alert(1)>', profile_url: 'javascript:alert(1)', picture: 'data:image/svg+xml,<svg onload=alert(1)>' }));
  st = await admin(base, tok, '/api/admin/state');
  const h = st.guests.find(g => g.yarnooId === 'u-110');
  check('javascript: and data: links never reach a phone', !!hostile.token && h && h.profileUrl === '', JSON.stringify(h));
  const hv = await json(base, `/api/me?token=${hostile.token}`);
  check('…and nor does a data: photo', hv.me.avatarUrl === '');

  // Seat a room and look at it from a phone.
  for (let i = 0; i < 9; i++) {
    await callback(base, await mint({ sub: `room-${i}`, name: `Member ${i}`, company: `Co ${i % 4}`, profile_url: `https://yarnoo.test/u/${i}`, picture: `https://cdn.yarnoo.test/${i}.jpg` }));
  }
  await admin(base, tok, '/api/admin/config', { colorCount: 5, huddleSize: 3 });
  await admin(base, tok, '/api/admin/action', { action: 'start' });
  const view = await json(base, `/api/me?token=${first.token}`);
  check('five Yarnoo colours on the wheel', view.colors.length === 5 && view.colors.map(c => c.id).join() === 'magenta,yellow,lilac,coral,pink', view.colors.map(c => c.id).join());
  const mate = view.assignment?.huddle?.find(p => p.profileUrl);
  check('group members carry their Yarnoo photo and profile link', !!mate && mate.avatarUrl.startsWith('https://') && mate.profileUrl.startsWith('https://yarnoo.test/u/'), JSON.stringify(view.assignment?.huddle));

  const csv = await fetch(base + '/api/admin/export.csv', { headers: { 'x-admin-token': tok } }).then(r => r.text());
  check('the CSV export carries Yarnoo ids and profiles', csv.split('\n')[0].includes('"yarnoo_id","yarnoo_profile"') && csv.includes('"u-100"'));

  await admin(base, tok, '/api/admin/action', { action: 'next' });
  await admin(base, tok, '/api/admin/action', { action: 'end' });
  const wrap = await json(base, `/api/me?token=${first.token}`);
  check('the wrap-up lists everyone the guest met, with profiles', Array.isArray(wrap.met) && wrap.met.length === wrap.metCount && wrap.met.some(p => p.profileUrl), `${wrap.met?.length} vs ${wrap.metCount}`);
  const late = await callback(base, await mint({ sub: 'late-arrival' }));
  check('nobody new is seated after the event ends', late.error === 'event_ended', late.location);
  const back = await callback(base, await mint({ sub: 'u-100' }));
  check('…but a member can still sign back in to see who they met', back.token === first.token);

  // --- profiles from Yarnoo's API, and a profile API that is down --------
  let apiDown = false;
  const api = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer api-key-1') { res.writeHead(401); return res.end(); }
    const id = decodeURIComponent(req.url.split('/').pop());
    if (id === 'u-down' || apiDown) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { id, display_name: 'Karim From API', headline: 'DJ', agency: 'Beat Lab', avatar_url: 'https://cdn.yarnoo.test/k.jpg', profile_url: `https://yarnoo.test/u/${id}` } }));
  }).listen(3319);
  const B = await boot(3312, {
    YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect',
    YARNOO_JWT_SECRET: SECRET,
    YARNOO_JWT_ISSUER: ISSUER,
    YARNOO_AUTH: 'optional',
    YARNOO_PROFILE_SOURCE: 'api',
    YARNOO_PROFILE_URL: 'http://localhost:3319/v1/profiles/{id}',
    YARNOO_API_KEY: 'api-key-1'
  });
  check('optional mode keeps the walk-in door open', (await fetch(B.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Walk In' }) })).status === 200);
  const fromApi = await callback(B.base, await mint({ sub: 'u-200', name: 'Token Name' }));
  const apiMe = await json(B.base, `/api/me?token=${fromApi.token}`);
  check('the profile API fills in the profile', apiMe.me?.name === 'Karim From API' && apiMe.me?.role === 'DJ' && apiMe.me?.company === 'Beat Lab', JSON.stringify(apiMe.me));
  const down = await callback(B.base, await mint({ sub: 'u-down', name: 'Still Gets In' }));
  const downMe = await json(B.base, `/api/me?token=${down.token}`);
  check('a profile API outage does not stop anyone at the door', downMe.me?.name === 'Still Gets In');
  apiDown = true;
  const outage = await callback(B.base, await mint({ sub: 'u-200', name: undefined, role: undefined, company: undefined }));
  const kept = await json(B.base, `/api/me?token=${outage.token}`);
  check('signing in again during an outage keeps the profile', outage.token === fromApi.token &&
    kept.me?.company === 'Beat Lab' && kept.me?.role === 'DJ' && kept.me?.avatarUrl === 'https://cdn.yarnoo.test/k.jpg', JSON.stringify(kept.me));
  apiDown = false;
  api.close();

  // --- configuration that must not boot -----------------------------------
  const noKey = await boot(3313, { YARNOO_AUTH: 'required', YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect' }, { expectExit: true });
  check('required sign-in without a key refuses to boot', noKey.code !== 0 && noKey.code !== 'still running' && /YARNOO_JWT_SECRET or YARNOO_JWKS_URL/.test(noKey.log()), noKey.log());
  const weak = await boot(3314, { YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect', YARNOO_JWT_SECRET: 'short' }, { expectExit: true });
  check('a short HS256 secret refuses to boot', weak.code !== 0 && weak.code !== 'still running' && /at least 32/.test(weak.log()), weak.log());
  const devWithKey = await boot(3318, { YARNOO_DEV_SIGNIN: '1', YARNOO_JWT_SECRET: SECRET, YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect' }, { expectExit: true });
  check('dev sign-in refuses to run next to a real Yarnoo key', devWithKey.code !== 0 && devWithKey.code !== 'still running' && /cannot run alongside/.test(devWithKey.log()), devWithKey.log());
  const badSsl = await boot(3320, {
    YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect', YARNOO_JWT_SECRET: SECRET,
    YARNOO_PROFILE_SOURCE: 'postgres', YARNOO_DATABASE_URL: 'postgres://ro@db.yarnoo.test/yarnoo',
    YARNOO_PROFILE_SQL: 'select * from p where id = $1', YARNOO_DATABASE_SSL: 'sure'
  }, { expectExit: true });
  check('an unknown YARNOO_DATABASE_SSL refuses to boot', badSsl.code !== 0 && badSsl.code !== 'still running' && /YARNOO_DATABASE_SSL must be/.test(badSsl.log()), badSsl.log());
  const halfEvent = await boot(3321, { YARNOO_EVENT_ID: EVENT }, { expectExit: true });
  check('an event id alone makes the event members-only and refuses to boot', halfEvent.code !== 0 && halfEvent.code !== 'still running' && /needs YARNOO_SIGNIN_URL/.test(halfEvent.log()), halfEvent.log());
  const halfKey = await boot(3322, { YARNOO_JWT_SECRET: SECRET, YARNOO_JWT_ISSUER: ISSUER }, { expectExit: true });
  check('a key without a sign-in URL refuses to boot', halfKey.code !== 0 && halfKey.code !== 'still running' && /needs YARNOO_SIGNIN_URL/.test(halfKey.log()), halfKey.log());
  const noIss = await boot(3323, { YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect', YARNOO_JWT_SECRET: SECRET }, { expectExit: true });
  check('sign-in without YARNOO_JWT_ISSUER refuses to boot', noIss.code !== 0 && noIss.code !== 'still running' && /YARNOO_JWT_ISSUER must be set/.test(noIss.log()), noIss.log());
  const weakPin = await boot(3324, { NODE_ENV: 'production', ADMIN_PIN: '1234' }, { expectExit: true });
  check('production refuses to start with a weak console PIN', weakPin.code !== 0 && weakPin.code !== 'still running' && /ADMIN_PIN/.test(weakPin.log()), weakPin.log());
  const prodDev = await boot(3315, {
    NODE_ENV: 'production', YARNOO_DEV_SIGNIN: '1', ADMIN_PIN: 'a-proper-passphrase',
    YARNOO_SIGNIN_URL: 'https://yarnoo.test/connect', YARNOO_JWT_SECRET: SECRET, YARNOO_JWT_ISSUER: ISSUER
  });
  check('dev sign-in never mounts in production', (await fetch(prodDev.base + '/auth/yarnoo/dev?redirect_uri=/auth/yarnoo/callback')).status === 404);
  check('production /health fails without Postgres', (await fetch(prodDev.base + '/health')).status === 503);
  const tries = [];
  for (let i = 0; i < 6; i++) {
    tries.push((await fetch(prodDev.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: `guess-${i}` }) })).status);
  }
  check('wrong console PINs are throttled', tries.slice(0, 5).every(code => code === 401) && tries[5] === 429, tries.join(','));
  const off = await boot(3316, {});
  check('with nothing configured the plain form still works', (await json(off.base, '/api/config')).auth === 'off' &&
    (await fetch(off.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Local' }) })).status === 200);
  // Colleagues with Arabic company names are kept apart like everyone else.
  const offAdmin = await adminToken(off.base);
  await admin(off.base, offAdmin, '/api/admin/action', { action: 'reset' });
  for (let i = 0; i < 10; i++) {
    await fetch(off.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `ضيف ${i}`, company: i < 5 ? 'فرقة النور' : 'شركة الأفق' }) });
  }
  await admin(off.base, offAdmin, '/api/admin/config', { colorCount: 5, useHuddles: false });
  const arabic = await admin(off.base, offAdmin, '/api/admin/action', { action: 'start' });
  check('colleagues with Arabic company names are kept apart', arabic.round?.stats?.colleaguePairs === 0, JSON.stringify(arabic.round?.stats));

  // An event saved by the eight-colour build must load into the five-colour one.
  const old = {
    version: 1,
    event: { name: 'Old', status: 'running', colorCount: 6, roundMinutes: 10, huddleSize: 6, useHuddles: true, showQuestions: false,
      roundIndex: 3, roundStartedAt: Date.now(), roundEndsAt: Date.now() + 300_000, pausedRemainingMs: null, absentAfterMinutes: 25 },
    round: { index: 3, groups: [['a'], ['b'], ['c'], ['d'], ['e'], ['f']], groupColor: [0, 1, 2, 3, 4, 5], huddlesPerColor: 1, stats: {}, computedMs: 1 },
    participants: 'abcdef'.split('').map((id, i) => ({ id, token: `tok-${id}`, name: `Guest ${id}`, company: '', role: '', companyKey: null,
      joinedAt: Date.now(), lastSeen: Date.now(), metCount: 0, color: i, group: i, history: [i, i, i] })),
    meetings: []
  };
  const O = await boot(3325, {}, { snapshot: old });
  const oTok = await adminToken(O.base);
  const oState = await admin(O.base, oTok, '/api/admin/state');
  const views = await Promise.all('abcdef'.split('').map(id => json(O.base, `/api/me?token=tok-${id}`)));
  check('an old eight-colour snapshot loads as five circles', oState.event.colorCount === 5 &&
    views.every(v => !v.assignment || (v.assignment.color && v.assignment.colorIndex < 5)),
    JSON.stringify({ colorCount: oState.event.colorCount, colours: views.map(v => v.assignment?.colorIndex) }));

  // --- the local stand-in for Yarnoo ---------------------------------------
  const D = await boot(3317, { YARNOO_DEV_SIGNIN: '1' });
  const dStart = await fetch(D.base + '/auth/yarnoo/start', { redirect: 'manual' });
  const dTo = new URL(dStart.headers.get('location'));
  check('dev sign-in stands in for Yarnoo locally', dTo.pathname === '/auth/yarnoo/dev');
  const pick = await fetch(D.base + '/auth/yarnoo/dev', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ redirect_uri: dTo.searchParams.get('redirect_uri'), state: dTo.searchParams.get('state'), member: '0' })
  });
  const dCb = new URL(pick.headers.get('location'));
  const dDone = await callback(D.base, dCb.searchParams.get('token'), { state: dCb.searchParams.get('state'), cookie: (dStart.headers.get('set-cookie') || '').split(';')[0] });
  check('…and its token signs a member in end to end', !!dDone.token, dDone.location);
  const open = await fetch(D.base + '/auth/yarnoo/dev', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ redirect_uri: 'https://evil.test/auth/yarnoo/callback', member: '0' })
  });
  check('…and will not hand a token to any other site', open.status === 400);
} catch (err) {
  console.error(err);
  fails++;
} finally {
  for (const s of servers) { try { s.kill(); } catch {} }
}

console.log(fails ? `\n${fails} FAILED` : '\nall Yarnoo sign-in checks passed');
process.exit(fails ? 1 : 0);
