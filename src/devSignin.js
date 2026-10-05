import { config, mintDevToken } from './yarnoo.js';

// ---------------------------------------------------------------------------
// A pretend Yarnoo sign-in page, for walking the whole flow on a laptop before
// Yarnoo's side exists. It does exactly what Yarnoo's real page has to do:
// pick a member, sign a token for them, redirect back to the callback.
//
// Mounted only when YARNOO_DEV_SIGNIN=1 and NODE_ENV is not production.
// ---------------------------------------------------------------------------

// Pretend members. Their profile links point at yarnoo.com so the profile
// buttons show up in a local run; they are not real profiles.
const MEMBERS = [
  { sub: 'dev-1001', name: 'Layla Haddad', role: 'Singer', company: 'Stage Nine' },
  { sub: 'dev-1002', name: 'Karim Aziz', role: 'DJ', company: 'Beat Lab' },
  { sub: 'dev-1003', name: 'Hana Yousef', role: 'Wedding Planner', company: 'Halo Events' },
  { sub: 'dev-1004', name: 'Nour El Din', role: 'Dancer', company: 'Dabke Collective' },
  { sub: 'dev-1005', name: 'ليلى منصور', role: 'Oud Player', company: 'Freelance' },
  { sub: 'dev-1006', name: 'Tariq Fares', role: 'Comedian', company: 'Freelance' }
].map(m => ({ ...m, profile_url: `https://yarnoo.com/?member=${m.sub}` }));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Only ever hand the token to our own callback - never an arbitrary URL. */
function sameOriginCallback(raw, base) {
  try {
    const url = new URL(raw, base);
    if (url.origin === new URL(base).origin && url.pathname === '/auth/yarnoo/callback') return url;
  } catch {}
  return null;
}

export function mountDevSignin(app, baseUrl) {
  if (!config.devSignin) return;
  console.warn('[yarnoo] dev sign-in is mounted at /auth/yarnoo/dev - never enable YARNOO_DEV_SIGNIN in production');

  app.get('/auth/yarnoo/dev', (req, res) => {
    const callback = sameOriginCallback(req.query.redirect_uri, baseUrl(req));
    if (!callback) return res.status(400).send('Bad redirect_uri');
    const hidden = `<input type="hidden" name="redirect_uri" value="${esc(callback.href)}">
      <input type="hidden" name="state" value="${esc(req.query.state)}">`;
    res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#A51374">
<title>Yarnoo sign-in (dev)</title>
<link rel="icon" href="/brand/yarnoo-icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<style>
  .dev-tag { display: inline-block; background: var(--yellow); color: var(--magenta); font-weight: 800; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; border-radius: 999px; padding: 5px 11px; }
  .members { display: grid; gap: 8px; margin: 14px 0 24px; }
  .members button { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; background: var(--surface); color: var(--white); border: 1px solid var(--line-soft); border-radius: 18px; padding: 11px 13px; }
  .members button b { display: block; font-weight: 600; }
  .members button span { font-size: 13px; font-weight: 400; color: var(--muted); }
  .members .avatar { background: var(--white); color: var(--magenta); }
</style></head>
<body><div class="wrap">
  <div class="topbar"><div class="brand-logo"><img src="/brand/yarnoo-logo-white.svg" alt="Yarnoo"></div><span class="dev-tag">Dev sign-in</span></div>
  <h1 class="hero-title" style="font-size:34px;margin-top:22px">Sign in to <span>Yarnoo</span></h1>
  <p class="hero-sub">Stand-in for Yarnoo's real sign-in page. Pick a member - the app receives a signed token for them, exactly as it will from Yarnoo.</p>
  <form method="post" action="/auth/yarnoo/dev">${hidden}
    <div class="members">
      ${MEMBERS.map((m, i) => `<button name="member" value="${i}">
        <div class="avatar">${esc(m.name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase())}</div>
        <div><b>${esc(m.name)}</b><span>${esc(m.role)} · ${esc(m.company)}</span></div></button>`).join('')}
    </div>
  </form>
  <form method="post" action="/auth/yarnoo/dev">${hidden}
    <div class="eyebrow" style="margin-bottom:12px">Or a member of your own</div>
    <div class="field"><label for="d-name">Name</label><input id="d-name" name="name" required maxlength="60"></div>
    <div class="field"><label for="d-role">Role</label><input id="d-role" name="role" maxlength="80"></div>
    <div class="field"><label for="d-company">Company</label><input id="d-company" name="company" maxlength="80"></div>
    <div class="field"><label for="d-sub">Yarnoo member id</label><input id="d-sub" name="sub" maxlength="120" placeholder="any id - the same id signs in to the same seat"></div>
    <button class="block" type="submit">Sign in</button>
  </form>
</div></body></html>`);
  });

  app.post('/auth/yarnoo/dev', async (req, res) => {
    const callback = sameOriginCallback(req.body?.redirect_uri, baseUrl(req));
    if (!callback) return res.status(400).send('Bad redirect_uri');
    const picked = MEMBERS[Number(req.body?.member)];
    const member = picked || {
      sub: req.body?.sub || `dev-${String(req.body?.name || 'guest').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: req.body?.name,
      role: req.body?.role,
      company: req.body?.company,
      profile_url: req.body?.profile_url
    };
    callback.searchParams.set('token', await mintDevToken(member));
    if (req.body?.state) callback.searchParams.set('state', req.body.state);
    res.redirect(303, callback.href);
  });
}
