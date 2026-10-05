# Spin The Wheel — Colors · Yarnoo

A live networking activation for **Yarnoo community events**. Guests sign in with
their Yarnoo profile, spin a colour wheel on their phone, and walk to the
matching coloured circle on the floor. Every few minutes the colour changes and
the room reshuffles. When the night ends, everyone has a list of the people they
met — linked to their Yarnoo profiles.

The wheel is theatre. The server decides each guest's colour **before** the
phone animates anything — that is the only way circles stay even and guests stop
re-meeting the same people.

Built by Ranna Studios for Yarnoo.

## Run it

```bash
npm install
ADMIN_PIN=1234 npm start                          # guests type their name
YARNOO_DEV_SIGNIN=1 ADMIN_PIN=1234 npm start      # try Sign in with Yarnoo locally
```

| Page | URL | Who |
|---|---|---|
| Guest | `/` | phones, via the QR |
| Operator console | `/admin` | whoever is running the room |
| Projector view | `/screen` | the big screen in the hall |

Copy `.env.example` to `.env` and set `ADMIN_PIN` before any real event.

## Sign in with Yarnoo

Guests are Yarnoo members, not anonymous names typed at the door. *Continue with
Yarnoo* sends the phone to Yarnoo, which signs the member in, checks they are
registered for the event, and sends them back with a short-lived signed token.
The app verifies it and seats the guest **as that profile**:

- **One profile, one seat.** Signing in again from another phone returns the
  same seat and history.
- **Photos and profile links** in every group list, and a *people you met* list
  at the end — the reason to sign in at all.
- **Members only, or members plus walk-ins** — `YARNOO_AUTH=required` (the default
  once configured) or `optional`. With nothing configured the plain name form is
  back, so local development needs no Yarnoo.
- Profiles come from the token, from Yarnoo's API, or from a read-only query on
  Yarnoo's Postgres — `YARNOO_PROFILE_SOURCE`.

Yarnoo's side is one endpoint. The contract, signing examples in Node, PHP and
Python, the deployment steps and the security model are in
**[docs/YARNOO-INTEGRATION.md](docs/YARNOO-INTEGRATION.md)**.
`npm run e2e:yarnoo` checks the whole handoff, including forged, expired,
replayed and wrong-event tokens.

## How the matching works

Cutting a room into groups so that everyone keeps meeting new people is the
[social golfer problem](https://en.wikipedia.org/wiki/Social_golfer_problem).
`src/assign.js` runs randomised greedy construction, then directed local search,
then ruin-and-recreate, under a time budget. It optimises four things at once:

1. **Even circles** — guaranteed by construction; every move preserves group size.
2. **No repeat meetings** — a pair who have already talked costs `met²`, so a
   second meeting is tolerated only when unavoidable and a third is fought hard.
3. **Colleagues kept apart** — people from the same company are pushed onto
   different circles. They can talk at the office.
4. **Everybody moves** — nobody is handed the same colour twice running.

### The one rule that decides whether this works

**A repeat-free round is only possible when the group size is no larger than the
number of groups.**

Sixty people on one circle, drawn from only five circles, forces repeat pairings
by pigeonhole from round two — no matching algorithm can fix it. That is why a
colour is split into **huddles**: the colour tells a guest where to walk, and
their phone names the 5–6 people they are actually talking to.

Five colours × ten huddles = fifty groups, which puts a 300-person room back
under the limit. `planGroups()` picks the huddle count automatically and will
never choose a shape that violates the rule. A 60-person circle was never a
conversation anyway.

This is also why the number of circles matters less than it looks: the planner
answers fewer colours with more huddles per circle. Five circles or ten, same
result.

### Measured

`npm run load` — 300 guests, 5 colours, 10 rounds:

```
round  1: matched 1150ms | 300 phones in 147ms | repeats 0 | colleagues 0 | circle spread 0
...
round 10: matched 1150ms | 300 phones in  57ms | repeats 0 | colleagues 0 | circle spread 0

avg distinct people met: 50.0 | repeat pairs across the whole event: 0
```

`npm run simulate` compares huddles against whole-circle matching on a synthetic
room. `GUESTS=180 COLORS=5 ROUNDS=12 npm run simulate` to change the shape.

## Colour: one palette, Yarnoo's

The interface and the circles on the floor are both Yarnoo. The five circle
colours are the Playbook's — **Magenta, Yellow, Lilac, Coral, Pink** — with the
short names a guest can say out loud to a stranger. They live in
`src/config.js` and reach the browser as inline styles; nothing in `style.css`
defines one.

They are ordered by how far apart they read, so a room with fewer circles still
gets the most separable set. The closest pair is **Pink and Lilac** (ΔE 26 —
clearly different on screen, the pair to light well and keep apart on the
floor). Because one circle colour is the page itself, every shape carrying a
circle colour — wheel segments, the result card, avatars, meters, projector dots
— has a white edge.

| Colour | Hex | Interface role | Text on it |
|---|---|---|---|
| Spotlight Magenta | `#A51374` | the stage: page ground, deeper shades for cards | white |
| Encore Yellow | `#FDEE4D` | calls to action, eyebrows, timers, the wheel pointer | magenta |
| Party Pink | `#FFB4FB` | accent words in headlines, the question rule | deep magenta |
| Dreamy Lilac | `#AFA6FF` | gradient | deep magenta |
| Lively Coral | `#FF656C` | warnings, disconnection, danger actions | deep magenta |
| Clean White | `#FFFFFF` | text, input fields, rims around circle colours | — |

The magenta is `#A51374`, not the `#B30077` printed in the Playbook: that is its
Pantone 214 C conversion, and every logo file and every page of the guide paints
`#A51374` on screen, so the interface and the logo stay one colour.

The Playbook gradient — yellow → pink → lilac → coral, "stage lights" — is kept
for the loudest moment of the night: rotation, on every phone and on the wall.

Type is **Bricolage Grotesque 72pt Bold** for headlines and **Onest** for
everything else (400 body, 600 calls to action, 800 subheads), self-hosted from
the brand's own files in `public/brand/fonts/` so nothing depends on venue wifi
reaching a font CDN.

**Logo:** the white Yarnoo lockup at the Playbook's 55px digital minimum. Every
asset is in `public/brand/` — see `public/brand/README.md`.

**Website:** `yarnoo.com` sits at the foot of all three pages.

## Sound and haptics

Every sound is synthesised with the Web Audio API. Nothing to download over
venue wifi, nothing to cache, no delay at the moment it matters.

| Cue | Sound | Vibration |
|---|---|---|
| Wheel spins | rising sweep, ticks thinning out as it slows | short pulse |
| Wheel lands | major arpeggio | double pulse |
| **Rotation** | two rising two-note calls over a low tone | long insistent pattern |
| Event ends | falling three-note resolve | soft double |

Guests get a sound toggle in the header; the choice is remembered. The projector
view arms the same rotation chime with one click, so it can carry through the
house speakers — which is louder and better than three hundred phone speakers,
though both firing together is its own moment.

Browsers refuse audio before a user gesture, so the context is unlocked on the
guest's first tap — joining as a walk-in, or the first spin after Yarnoo sign-in
— and on the arm-screen tap (projector).

## Operating it

Start the event from `/admin` once the room has filled a little. The console
shows live circle counts, a health readout per round (repeats, colleague
pairings, how long matching took), which guests signed in with Yarnoo (with a
link to each profile), and lets you rotate early, add or remove a minute, pause,
and export a CSV of everyone who attended — including their Yarnoo ids.

- **Late arrivals** are seated immediately into the emptiest, least-conflicting
  huddle — they never wait out a round.
- **Phones in pockets** are fine. Guests stay on the roster for
  `absentAfterMinutes` (25 by default) of total silence, and the page re-syncs
  on wake, on reconnect, and by polling when the socket drops.
- **A restart mid-event loses nothing.** State is snapshotted continuously; if a
  round expired while the server was down, it rotates on boot.

## Deploying

One Node service and Postgres; on Railway, `railway.json` is already set up.
The full checklist — variables, the Yarnoo settings, and the custom domain — is
in [docs/YARNOO-INTEGRATION.md](docs/YARNOO-INTEGRATION.md#putting-it-on-a-yarnoo-domain).
Three things worth knowing up front:

- **Set `PUBLIC_URL`** to the domain guests use. The QR code encodes it and the
  Yarnoo `redirect_uri` is built from it.
- **A custom domain needs two DNS records** on Railway: the `CNAME` routes
  traffic and the `TXT _railway-verify.<subdomain>` proves ownership. With only
  the CNAME the domain never verifies, no certificate is issued, and Railway's
  edge answers every request with its own 404 — which looks like a routing bug
  and is not one. Do not delete and re-add a stalled domain; Let's Encrypt
  rate-limits duplicate certificates and a re-add can change the CNAME target.
  `scripts/watch-domain.sh <domain> <cname target>` polls until HTTPS is live.
- **Keep it to one replica.** The live event lives in memory and is snapshotted
  to Postgres. Two replicas would each hold their own copy of the room and hand
  out contradictory colours, so `numReplicas` is pinned to 1. Scaling this app
  means moving round state into Postgres proper, not adding instances.

`/health` reports which store won and the sign-in mode, so a deploy that quietly
fell back to file storage — or came up without Yarnoo sign-in — is visible
before an event rather than during one.

## Layout

```
src/assign.js      the matching engine — no I/O, pure functions, the interesting part
src/state.js       the live event: guests, rounds, meeting history, views
src/yarnoo.js      Sign in with Yarnoo: token verification, profile sources
src/devSignin.js   a stand-in Yarnoo sign-in page for local testing
src/store.js       snapshot persistence (Postgres or file)
src/config.js      palette, icebreaker questions, cost weights
src/server.js      HTTP + WebSocket
public/            guest page, operator console, projector view, brand assets
docs/              the Yarnoo integration guide
scripts/           e2e checks, load test, offline simulation, test tokens
```

Tuning lives in `src/config.js` — `WEIGHTS` decides how hard the matcher fights
repeat meetings versus colleague pairings.
