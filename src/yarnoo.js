import crypto from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// Sign in with Yarnoo.
//
// Guests are Yarnoo members, not strangers typing a name into a form. The
// event app never sees a Yarnoo password and never needs Yarnoo's database to
// let someone in; Yarnoo vouches for them with a signed token instead:
//
//   1. The QR opens this app. "Continue with Yarnoo" goes to /auth/yarnoo/start,
//      which sends the phone to YARNOO_SIGNIN_URL with a redirect_uri and state.
//   2. Yarnoo signs the member in (or sees they already are), checks they are
//      registered for the event, and redirects back to
//      /auth/yarnoo/callback?token=<JWT>&state=<state>.
//   3. We verify the token - signature, issuer, audience, age, single use, and
//      the event it was issued for - and seat the member as that profile.
//
// The token carries the profile (sub, name, picture, role, company,
// profile_url). If Yarnoo would rather keep the token small, the profile can
// be fetched by id instead - from Yarnoo's API, or read-only from its Postgres.
// docs/YARNOO-INTEGRATION.md is the contract for the Yarnoo side.
// ---------------------------------------------------------------------------

const env = process.env;
const production = env.NODE_ENV === 'production';

/** Raised for anything that should send the guest back to the door with a reason. */
export class SignInError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

const MODES = ['off', 'optional', 'required'];

// A local stand-in for Yarnoo's sign-in page, so the whole flow can be walked
// through before Yarnoo's side exists. Refuses to exist in production, and
// refuses to run next to a real Yarnoo key (see assertConfigured) - it signs
// with a throwaway secret of its own, so it can never mint a token a real
// deployment would accept.
const devSignin = env.YARNOO_DEV_SIGNIN === '1' && !production;

// HS256 needs a secret Yarnoo and this app share.
const secretText = env.YARNOO_JWT_SECRET || (devSignin ? crypto.randomBytes(32).toString('hex') : '');
const secret = secretText ? new TextEncoder().encode(secretText) : null;
// RS256 / PS256 / ES256 / EdDSA: Yarnoo publishes its public keys and keeps the private one.
const jwks = env.YARNOO_JWKS_URL ? createRemoteJWKSet(new URL(env.YARNOO_JWKS_URL)) : null;

const signinUrl = env.YARNOO_SIGNIN_URL || (devSignin ? '/auth/yarnoo/dev' : '');

export const config = {
  mode: resolveMode(),
  signinUrl,
  issuer: env.YARNOO_JWT_ISSUER || (devSignin ? 'yarnoo-dev' : ''),
  audience: env.YARNOO_JWT_AUDIENCE || 'spin-the-wheel',
  eventId: env.YARNOO_EVENT_ID || '',
  profileSource: (env.YARNOO_PROFILE_SOURCE || 'claims').toLowerCase(),
  // TLS to Yarnoo's database: certificates are verified unless told otherwise.
  databaseSsl: (env.YARNOO_DATABASE_SSL || 'verify').toLowerCase(),
  devSignin
};

function resolveMode() {
  const asked = (env.YARNOO_AUTH || '').toLowerCase();
  if (asked && !MODES.includes(asked)) {
    throw new Error(`[yarnoo] YARNOO_AUTH must be one of ${MODES.join(', ')} - got "${env.YARNOO_AUTH}"`);
  }
  if (asked) return asked;
  // The local dev sign-in keeps the guest form too, so both doors can be tried.
  if (devSignin) return 'optional';
  // Any sign of a Yarnoo setup means members only - and assertConfigured()
  // then insists on the rest. A typo in one variable name must stop the
  // deploy, not quietly open a members-only event to anyone with a name.
  return env.YARNOO_SIGNIN_URL || env.YARNOO_JWT_SECRET || env.YARNOO_JWKS_URL || env.YARNOO_EVENT_ID
    ? 'required'
    : 'off';
}

/**
 * Fail at boot, not at the door. A half-configured sign-in would either lock
 * every guest out or quietly let anyone in, and either one is discovered by a
 * queue of people holding phones.
 */
export function assertConfigured() {
  // A dev flag left on in a deployment must not become "sign in as anyone".
  if (devSignin && (env.YARNOO_JWT_SECRET || env.YARNOO_JWKS_URL || env.YARNOO_SIGNIN_URL)) {
    throw new Error('[yarnoo] YARNOO_DEV_SIGNIN=1 cannot run alongside a real Yarnoo configuration ' +
      '(YARNOO_SIGNIN_URL / YARNOO_JWT_SECRET / YARNOO_JWKS_URL) - unset YARNOO_DEV_SIGNIN, and set NODE_ENV=production on deployments');
  }
  if (config.mode === 'off') {
    console.log('[yarnoo] sign-in off - guests type their own name');
    return;
  }
  const missing = [];
  if (!config.signinUrl) missing.push('YARNOO_SIGNIN_URL');
  if (!secret && !jwks) missing.push('YARNOO_JWT_SECRET or YARNOO_JWKS_URL');
  if (missing.length) {
    throw new Error(`[yarnoo] YARNOO_AUTH=${config.mode} needs ${missing.join(' and ')}`);
  }
  if (secret && !jwks && secret.length < 32) {
    throw new Error('[yarnoo] YARNOO_JWT_SECRET must be at least 32 characters - HS256 is only as strong as its secret');
  }
  if (secret && jwks) {
    console.warn('[yarnoo] both YARNOO_JWT_SECRET and YARNOO_JWKS_URL are set - verifying with the JWKS only');
  }
  if (config.profileSource === 'api' && !env.YARNOO_PROFILE_URL) {
    throw new Error('[yarnoo] YARNOO_PROFILE_SOURCE=api needs YARNOO_PROFILE_URL');
  }
  if (config.profileSource === 'postgres' && !(env.YARNOO_DATABASE_URL && env.YARNOO_PROFILE_SQL)) {
    throw new Error('[yarnoo] YARNOO_PROFILE_SOURCE=postgres needs YARNOO_DATABASE_URL and YARNOO_PROFILE_SQL');
  }
  if (!['verify', 'no-verify', 'disable'].includes(config.databaseSsl)) {
    throw new Error(`[yarnoo] YARNOO_DATABASE_SSL must be verify, no-verify or disable - got "${env.YARNOO_DATABASE_SSL}"`);
  }
  if (config.profileSource === 'postgres' && /[?&](sslmode|sslrootcert)=/i.test(env.YARNOO_DATABASE_URL)) {
    console.warn('[yarnoo] YARNOO_DATABASE_URL carries sslmode/sslrootcert - those override YARNOO_DATABASE_SSL');
  }
  // Without it, any token signed with the key is accepted whoever issued it.
  if (!config.issuer) {
    throw new Error('[yarnoo] YARNOO_JWT_ISSUER must be set to the exact `iss` Yarnoo signs with');
  }
  if (!['claims', 'api', 'postgres'].includes(config.profileSource)) {
    throw new Error(`[yarnoo] YARNOO_PROFILE_SOURCE must be claims, api or postgres - got "${config.profileSource}"`);
  }
  console.log(
    `[yarnoo] sign-in ${config.mode}, keys from ${jwks ? 'JWKS' : 'shared secret'}, ` +
    `profiles from ${config.profileSource}${config.eventId ? `, event ${config.eventId}` : ''}` +
    `${devSignin ? ' - DEV SIGN-IN ENABLED' : ''}`
  );
}

/** What the guest page and console need to know. Nothing secret. */
export function publicConfig() {
  return {
    auth: config.mode,
    signinPath: config.mode === 'off' ? null : '/auth/yarnoo/start'
  };
}

// --- the handoff -------------------------------------------------------------

/** Where Yarnoo should send the member back to. */
export function callbackUrl(base) {
  return `${base}/auth/yarnoo/callback`;
}

/** The URL that starts sign-in on Yarnoo's side. */
export function signinRedirect(base, state) {
  const url = new URL(config.signinUrl, base);
  url.searchParams.set('redirect_uri', callbackUrl(base));
  url.searchParams.set('state', state);
  url.searchParams.set('audience', config.audience);
  if (config.eventId) url.searchParams.set('event', config.eventId);
  return url.href;
}

// A token is good for one sign-in. Remember the ids we have accepted until
// they would have expired anyway.
const usedTokenIds = new Map();
const pruneUsed = setInterval(() => {
  const now = Date.now();
  for (const [jti, until] of usedTokenIds) if (until < now) usedTokenIds.delete(jti);
}, 60_000);
pruneUsed.unref();

/**
 * Verify Yarnoo's token and return the member it vouches for.
 * Throws SignInError with a code the guest page can explain.
 */
export async function verifyHandoff(token) {
  if (!token || typeof token !== 'string' || token.length > 8192) {
    throw new SignInError('missing_token');
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks || secret, {
      // Pinned per key type, so a token cannot choose its own algorithm.
      algorithms: jwks ? ['RS256', 'PS256', 'ES256', 'EdDSA'] : ['HS256'],
      audience: config.audience,
      issuer: config.issuer || undefined,
      requiredClaims: ['sub', 'iat', 'exp', 'jti'],
      maxTokenAge: '10m',
      clockTolerance: 60
    }));
  } catch (err) {
    // jose reports both a passed `exp` and an `iat` older than maxTokenAge as
    // expired. Yarnoo's key set being unreachable is an outage, not a forgery.
    const code = err?.code === 'ERR_JWT_EXPIRED' ? 'expired'
      : err?.code === 'ERR_JWKS_TIMEOUT' || (jwks && err?.code === 'ERR_JOSE_GENERIC') ? 'unavailable'
      : 'invalid_token';
    throw new SignInError(code, err?.message);
  }

  if (config.eventId) {
    const events = [payload.event, ...(Array.isArray(payload.events) ? payload.events : [])].map(String);
    if (!events.includes(config.eventId)) throw new SignInError('not_registered');
  }

  // Every token is single use. The callback URL that carries it can end up in
  // a shared phone's history or a proxy log; replaying it must not seat anyone.
  const jti = payload.jti;
  if (typeof jti !== 'string' || !jti || jti.length > 200) throw new SignInError('invalid_token', 'missing or malformed jti');
  if (usedTokenIds.has(jti)) throw new SignInError('already_used');
  // Remember it only as long as jose would still accept it, whatever its exp says.
  usedTokenIds.set(jti, Math.min(payload.exp, payload.iat + 600) * 1000 + 60_000);

  const fromClaims = profileFrom(payload);
  if (!fromClaims.id) throw new SignInError('invalid_token', 'empty sub');
  // No real member is called "." or "..", and either would walk up a path
  // when substituted into YARNOO_PROFILE_URL.
  if (fromClaims.id === '.' || fromClaims.id === '..') throw new SignInError('invalid_token', 'dot-segment sub');
  const enriched = await enrich(fromClaims.id);
  return mergeProfiles(fromClaims, enriched);
}

// --- profiles ----------------------------------------------------------------

const text = (value, max) => (typeof value === 'string' || typeof value === 'number')
  ? String(value).replace(/\s+/g, ' ').trim().slice(0, max)
  : '';

/**
 * Only real web links reach a phone. A profile field is user-controlled data
 * on Yarnoo's side, and a `javascript:` URL rendered as a link is an XSS.
 */
export function safeUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1000) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && !production) return url.href;
  } catch {}
  return '';
}

const first = (...values) => values.find(v => v !== undefined && v !== null && v !== '');

/** One mapping for token claims, API JSON and database rows alike. */
export function profileFrom(src = {}) {
  const fullName = [src.given_name || src.first_name, src.family_name || src.last_name].filter(Boolean).join(' ');
  return {
    id: text(first(src.sub, src.id, src.user_id, src.yarnoo_id), 120),
    name: text(first(src.name, src.display_name, src.full_name, fullName), 60),
    company: text(first(src.company, src.organization, src.agency), 80),
    role: text(first(src.role, src.headline, src.category, src.title), 80),
    avatarUrl: safeUrl(first(src.picture, src.avatar_url, src.avatar, src.photo_url)),
    profileUrl: safeUrl(first(src.profile_url, src.profile, src.url))
  };
}

function mergeProfiles(base, extra) {
  if (!extra) return base;
  const out = { ...base };
  for (const key of ['name', 'company', 'role', 'avatarUrl', 'profileUrl']) {
    if (extra[key]) out[key] = extra[key];
  }
  return out;
}

let pgPool = null;

/**
 * Optional second source for the profile. If it is slow or down the guest
 * still gets in on what the token said - a queue at the door is worse than a
 * missing photo.
 */
async function enrich(id) {
  try {
    if (config.profileSource === 'api') return await fromApi(id);
    if (config.profileSource === 'postgres') return await fromPostgres(id);
  } catch (err) {
    console.warn(`[yarnoo] profile lookup for ${id} failed, using the token's claims: ${err.message}`);
  }
  return null;
}

async function fromApi(id) {
  const url = env.YARNOO_PROFILE_URL.replace('{id}', encodeURIComponent(id));
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      ...(env.YARNOO_API_KEY ? { authorization: `Bearer ${env.YARNOO_API_KEY}` } : {})
    },
    signal: AbortSignal.timeout(4000)
  });
  if (!res.ok) throw new Error(`profile API answered ${res.status}`);
  const body = await res.json();
  return profileFrom(body?.data ?? body);
}

async function fromPostgres(id) {
  if (!pgPool) {
    const { default: pg } = await import('pg');
    pgPool = new pg.Pool({
      connectionString: env.YARNOO_DATABASE_URL,
      max: 3,
      keepAlive: true,
      statement_timeout: 3000,
      query_timeout: 3000,
      connectionTimeoutMillis: 3000,
      // Verified TLS unless told otherwise. Managed databases with a private CA
      // (RDS, Azure, ...) need YARNOO_DATABASE_CA, the CA bundle as PEM.
      ssl: config.databaseSsl === 'disable' ? false
        : config.databaseSsl === 'no-verify' ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ...(env.YARNOO_DATABASE_CA ? { ca: env.YARNOO_DATABASE_CA.replace(/\\n/g, '\n') } : {}) }
    });
  }
  // The query is the operator's (YARNOO_PROFILE_SQL), the id is always a
  // bound parameter - never spliced into the SQL.
  const { rows } = await pgPool.query(env.YARNOO_PROFILE_SQL, [id]);
  return rows[0] ? profileFrom(rows[0]) : null;
}

// --- local dev sign-in -------------------------------------------------------

/** Mint a token exactly as Yarnoo would. Dev sign-in and tests only. */
export async function mintDevToken(profile) {
  if (!devSignin) throw new Error('dev sign-in is off');
  return new SignJWT({
    name: profile.name,
    role: profile.role,
    company: profile.company,
    picture: profile.picture || undefined,
    profile_url: profile.profile_url || undefined,
    ...(config.eventId ? { event: config.eventId } : {})
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(profile.sub))
    .setIssuer(config.issuer || 'yarnoo-dev')
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(crypto.randomUUID())
    .sign(secret);
}
