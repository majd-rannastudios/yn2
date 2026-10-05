// Mint a sign-in token exactly as Yarnoo will, and print the callback URL that
// uses it. For testing a deployment before Yarnoo's side exists, or for
// checking what the app does with a given profile.
//
//   YARNOO_JWT_SECRET=... YARNOO_JWT_ISSUER=https://yarnoo.com \
//     node scripts/yarnoo-token.js --base https://event.yarnoo.com \
//       --sub 42 --name "Layla Haddad" --role Singer --company "Stage Nine" \
//       --picture https://cdn.yarnoo.com/u/42.jpg --profile https://yarnoo.com/u/layla
//
// Reads YARNOO_JWT_SECRET, YARNOO_JWT_ISSUER, YARNOO_JWT_AUDIENCE and
// YARNOO_EVENT_ID from the environment - export the same values the deployment
// uses (the issuer must match exactly), or pass --event. The URL works once,
// within 5 minutes (--ttl), and the guest it seats is real: Reset everything in
// the console before the event.
// HS256 only: with a JWKS setup the private key lives with Yarnoo, not here.

import crypto from 'node:crypto';
import { SignJWT } from 'jose';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const secret = process.env.YARNOO_JWT_SECRET;
if (!secret) {
  console.error('Set YARNOO_JWT_SECRET to the secret the server is using.');
  process.exit(1);
}

const sub = arg('sub', 'test-member');
const claims = {
  name: arg('name', 'Test Member'),
  role: arg('role'),
  company: arg('company'),
  picture: arg('picture'),
  profile_url: arg('profile'),
  event: arg('event', process.env.YARNOO_EVENT_ID)
};
for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];

const token = await new SignJWT(claims)
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(String(sub))
  .setIssuer(process.env.YARNOO_JWT_ISSUER || 'yarnoo-dev')
  .setAudience(process.env.YARNOO_JWT_AUDIENCE || 'spin-the-wheel')
  .setIssuedAt()
  .setExpirationTime(arg('ttl', '5m'))
  .setJti(crypto.randomUUID())
  .sign(new TextEncoder().encode(secret));

const base = (arg('base', process.env.PUBLIC_URL || 'http://localhost:3000')).replace(/\/$/, '');
console.log(`${base}/auth/yarnoo/callback?token=${token}`);
