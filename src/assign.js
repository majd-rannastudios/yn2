import { WEIGHTS } from './config.js';

// ---------------------------------------------------------------------------
// The assignment engine.
//
// Every round the room has to be cut into K colour groups, and two goals pull
// against each other:
//   1. circles must be even - nobody wants to walk over to a circle of three
//   2. guests should keep meeting NEW people, round after round
//
// That is the social golfer problem: no cheap exact answer, so we run
// randomised greedy construction, then directed local search (take the single
// best swap for each guest), then ruin-and-recreate to break out of local
// optima. Swaps and rebuilds both preserve circle sizes, so balance holds by
// construction and the search only ever optimises who meets whom.
//
// Everything inside the search runs on integer indices and flat typed arrays;
// the string ids only exist at the edges.
// ---------------------------------------------------------------------------

export function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Work out the group structure for a room.
 *
 * A colour is WHERE you walk. A huddle is WHO you talk to once you get there.
 * The distinction is what makes the whole thing work, for one hard reason:
 * a round with no repeat pairings is only possible when the group size is no
 * bigger than the number of groups. Sixty people milling on one circle, with
 * only five circles to draw from, forces repeats by pigeonhole from round two
 * onward - and sixty people is a crowd, not a conversation.
 *
 * So we cut each colour into huddles of ~`targetHuddleSize`, name them on the
 * guest's phone, and the matching runs at huddle granularity. Five colours of
 * ten huddles is fifty groups, which puts a 300-person room back under the limit.
 *
 * @returns {{ groupCount, groupColor, huddlesPerColor }} groupColor[g] is the
 *          colour index that group g belongs to.
 */
export function planGroups(n, colorCount, targetHuddleSize = 6) {
  // Try every sane number of huddles per colour and keep the best. Two rules
  // decide it: groups should be near the size the operator asked for, and
  // - far more important - a repeat-free round is only possible when the
  // group size is no larger than the number of groups. Violating that is
  // heavily penalised, because no amount of clever matching recovers from it.
  const MIN_GROUP = 3;
  const maxHuddles = Math.max(1, Math.floor(n / (colorCount * MIN_GROUP)));

  let huddlesPerColor = 1;
  let bestScore = Infinity;
  for (let h = 1; h <= maxHuddles; h++) {
    const groups = colorCount * h;
    const size = n / groups;
    if (size < MIN_GROUP && h > 1) continue;
    const pigeonhole = size > groups ? 1000 : 0;
    const score = pigeonhole + Math.abs(size - targetHuddleSize);
    if (score < bestScore) { bestScore = score; huddlesPerColor = h; }
  }

  const groupCount = colorCount * huddlesPerColor;
  const groupColor = new Int32Array(groupCount);
  // Interleave so consecutive groups belong to different colours; every colour
  // then holds exactly `huddlesPerColor` groups and stays evenly filled.
  for (let g = 0; g < groupCount; g++) groupColor[g] = g % colorCount;
  return { groupCount, groupColor, huddlesPerColor };
}

/** Target group sizes: as even as the arithmetic allows. */
export function targetSizes(n, k, roundIndex = 0) {
  const base = Math.floor(n / k);
  const extra = n % k;
  const sizes = new Array(k).fill(base);
  // The remainder seats rotate, so the same colour is not always the busy one.
  for (let i = 0; i < extra; i++) sizes[(i + roundIndex) % k] += 1;
  return sizes;
}

/**
 * Assign everyone a group for the next round.
 *
 * @param {Array}  people   [{ id, companyKey, lastColor }]
 * @param {number} k        how many groups (colours x huddles) to fill
 * @param {Map}    meetings pairKey -> rounds already shared
 * @param {object} opts     { roundIndex, budgetMs, seed, groupColor }
 */
export function assignRound(people, k, meetings, opts = {}) {
  const { roundIndex = 0, budgetMs = 1500, seed = Date.now(), groupColor = null } = opts;
  const n = people.length;
  if (n === 0) {
    return { groups: Array.from({ length: k }, () => []), cost: 0, stats: emptyStats(), ms: 0 };
  }

  const t0 = Date.now();
  const rng = mulberry32(seed);
  const ctx = buildContext(people, k, meetings, roundIndex, groupColor);

  let best = null;
  let bestCost = Infinity;
  const deadline = t0 + budgetMs;
  // Restart from scratch a few times; whichever run ends lowest wins.
  const restarts = n > 400 ? 2 : 4;

  for (let r = 0; r < restarts; r++) {
    if (r > 0 && Date.now() >= deadline) break;
    const slice = t0 + Math.round((budgetMs * (r + 1)) / restarts);
    const where = construct(ctx, rng);
    optimise(ctx, where, rng, Math.min(slice, deadline));
    const cost = totalCost(ctx, where);
    if (cost < bestCost) { bestCost = cost; best = where.slice(); }
  }

  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) groups[best[i]].push(people[i]);

  return { groups, cost: bestCost, stats: describe(groups, meetings), ms: Date.now() - t0 };
}

/** Seat one late arrival into an already running round. */
export function placeLatecomer(person, groups, meetings, groupColor = null) {
  const smallest = Math.min(...groups.map(g => g.length));
  let best = 0;
  let bestScore = Infinity;
  for (let g = 0; g < groups.length; g++) {
    // Balance wins: only the emptiest groups are candidates.
    if (groups[g].length > smallest) continue;
    const color = groupColor ? groupColor[g] : g;
    let score = person.lastColor === color ? WEIGHTS.stayPut : 0;
    for (const q of groups[g]) {
      const met = meetings.get(pairKey(person.id, q.id)) || 0;
      score += met * met * WEIGHTS.repeat;
      if (person.companyKey && person.companyKey === q.companyKey) score += WEIGHTS.sameCompany;
    }
    if (score < bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// --- internals -------------------------------------------------------------

/**
 * Flatten the room into typed arrays. pc[i*n+j] is the full cost of putting i
 * and j in the same circle, so the hot loops are single array reads.
 */
function buildContext(people, k, meetings, roundIndex, groupColor) {
  const n = people.length;
  const index = new Map(people.map((p, i) => [p.id, i]));

  const company = new Int32Array(n).fill(-1);
  const companyIds = new Map();
  for (let i = 0; i < n; i++) {
    const key = people[i].companyKey;
    if (!key) continue;
    if (!companyIds.has(key)) companyIds.set(key, companyIds.size);
    company[i] = companyIds.get(key);
  }

  const lastColor = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const c = people[i].lastColor;
    if (typeof c === 'number' && c >= 0) lastColor[i] = c;
  }

  const pc = new Int32Array(n * n);
  // Seed from the pairs that actually met - far cheaper than scanning n^2.
  for (const [key, met] of meetings) {
    if (!met) continue;
    const sep = key.indexOf('|');
    const i = index.get(key.slice(0, sep));
    const j = index.get(key.slice(sep + 1));
    if (i === undefined || j === undefined) continue;
    const cost = met * met * WEIGHTS.repeat;
    pc[i * n + j] = cost;
    pc[j * n + i] = cost;
  }
  // Then layer the colleague penalty on top.
  for (let i = 0; i < n; i++) {
    if (company[i] < 0) continue;
    for (let j = i + 1; j < n; j++) {
      if (company[j] !== company[i]) continue;
      pc[i * n + j] += WEIGHTS.sameCompany;
      pc[j * n + i] += WEIGHTS.sameCompany;
    }
  }

  // With no explicit map, every group is its own colour.
  const colors = groupColor || Int32Array.from({ length: k }, (_, g) => g);

  return { n, k, pc, company, lastColor, groupColor: colors, sizes: targetSizes(n, k, roundIndex) };
}

// The move penalty is about the COLOUR, not the huddle: what matters is that
// the guest physically walks to a different circle than they did last round.
const stay = (ctx, i, g) => (ctx.lastColor[i] === ctx.groupColor[g] ? WEIGHTS.stayPut : 0);

/** Cost of i sitting in group g, ignoring member `skip`. */
function costIn(ctx, groups, i, g, skip) {
  const { pc, n } = ctx;
  const row = i * n;
  const members = groups[g];
  let total = stay(ctx, i, g);
  for (let m = 0; m < members.length; m++) {
    const j = members[m];
    if (j === i || j === skip) continue;
    total += pc[row + j];
  }
  return total;
}

/** Randomised greedy: constrained guests first, cheapest open seat wins. */
function construct(ctx, rng) {
  const { n, k, sizes } = ctx;
  const groups = Array.from({ length: k }, () => []);
  const where = new Int32Array(n).fill(-1);

  const order = Array.from(shuffleIdx(n, rng));
  // Whoever already has a colour is the constrained one; place them first and
  // let the unconstrained arrivals absorb whatever is left.
  order.sort((a, b) => (ctx.lastColor[b] >= 0 ? 1 : 0) - (ctx.lastColor[a] >= 0 ? 1 : 0));

  for (const i of order) {
    let best = -1;
    let bestCost = Infinity;
    for (let g = 0; g < k; g++) {
      if (groups[g].length >= sizes[g]) continue;
      const cost = costIn(ctx, groups, i, g, -1) + groups[g].length * 0.001;
      if (cost < bestCost) { bestCost = cost; best = g; }
    }
    groups[best].push(i);
    where[i] = best;
  }
  return where;
}

function toGroups(ctx, where) {
  const groups = Array.from({ length: ctx.k }, () => []);
  for (let i = 0; i < ctx.n; i++) groups[where[i]].push(i);
  return groups;
}

function totalCost(ctx, where) {
  const groups = toGroups(ctx, where);
  const { pc, n } = ctx;
  let total = 0;
  for (let g = 0; g < groups.length; g++) {
    const members = groups[g];
    for (let a = 0; a < members.length; a++) {
      const i = members[a];
      total += stay(ctx, i, g);
      for (let b = a + 1; b < members.length; b++) total += pc[i * n + members[b]];
    }
  }
  return total;
}

/**
 * Directed local search plus ruin-and-recreate.
 *
 * Sweep every guest; for each, find the single best swap partner anywhere in
 * the room and take it. When a whole sweep finds nothing, tear out a random
 * fifth of the room and rebuild it greedily - that kicks the solution out of
 * the local optimum. The best state seen is what we keep.
 */
function optimise(ctx, where, rng, deadline) {
  const groups = toGroups(ctx, where);
  let current = totalCost(ctx, where);
  let bestCost = current;
  let bestWhere = where.slice();

  while (Date.now() < deadline) {
    const gain = sweep(ctx, groups, where, deadline);
    current -= gain;

    if (current < bestCost) {
      bestCost = current;
      bestWhere = where.slice();
    }

    if (gain > 0) continue;            // still improving - keep sweeping
    if (Date.now() >= deadline) break;

    ruinAndRecreate(ctx, groups, where, rng, 0.2);
    current = totalCost(ctx, where);
  }

  for (let i = 0; i < ctx.n; i++) where[i] = bestWhere[i];
  return bestCost;
}

/** One pass over the room, taking each guest's best improving swap. */
function sweep(ctx, groups, where, deadline) {
  const { n, k, pc } = ctx;
  let gained = 0;

  for (let i = 0; i < n; i++) {
    // Time is checked in batches - Date.now() in the inner loop is not free.
    if ((i & 63) === 0 && Date.now() >= deadline) break;

    const g = where[i];
    const iHere = costIn(ctx, groups, i, g, -1);
    const rowI = i * n;

    let bestDelta = -1e-9;
    let bestPartner = -1;
    let bestGroup = -1;

    for (let h = 0; h < k; h++) {
      if (h === g) continue;
      const members = groups[h];
      const iThereFull = costIn(ctx, groups, i, h, -1);
      for (let m = 0; m < members.length; m++) {
        const j = members[m];
        // After the swap neither pays for the other, hence the subtraction.
        const iThere = iThereFull - pc[rowI + j];
        const jHere = costIn(ctx, groups, j, h, -1);
        const jThere = costIn(ctx, groups, j, g, i);
        const delta = iThere + jThere - (iHere + jHere);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPartner = j;
          bestGroup = h;
        }
      }
    }

    if (bestPartner >= 0) {
      swapMembers(groups, where, i, g, bestPartner, bestGroup);
      gained -= bestDelta;
    }
  }
  return gained;
}

function swapMembers(groups, where, i, gi, j, gj) {
  const G = groups[gi];
  const H = groups[gj];
  G[G.indexOf(i)] = j;
  H[H.indexOf(j)] = i;
  where[i] = gj;
  where[j] = gi;
}

/** Tear out a random slice of the room and greedily rebuild it. */
function ruinAndRecreate(ctx, groups, where, rng, fraction) {
  const { n, k, sizes } = ctx;
  const victims = [];
  for (let i = 0; i < n; i++) {
    if (rng() < fraction) victims.push(i);
  }
  if (victims.length < 2) return;

  const removed = new Set(victims);
  for (let g = 0; g < k; g++) {
    groups[g] = groups[g].filter(i => !removed.has(i));
  }

  for (const i of shuffleArray(victims, rng)) {
    let best = -1;
    let bestCost = Infinity;
    for (let g = 0; g < k; g++) {
      if (groups[g].length >= sizes[g]) continue;
      const cost = costIn(ctx, groups, i, g, -1);
      if (cost < bestCost) { bestCost = cost; best = g; }
    }
    groups[best].push(i);
    where[i] = best;
  }
}

// --- reporting -------------------------------------------------------------

function emptyStats() {
  return { people: 0, sizes: [], repeats: 0, freshPairs: 0, colleaguePairs: 0, freshRate: 1 };
}

/** Human-readable quality report - surfaced live in the admin console. */
export function describe(groups, meetings) {
  let repeats = 0;
  let fresh = 0;
  let colleagues = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if ((meetings.get(pairKey(a.id, b.id)) || 0) > 0) repeats++; else fresh++;
        if (a.companyKey && a.companyKey === b.companyKey) colleagues++;
      }
    }
  }
  const totalPairs = repeats + fresh;
  return {
    people: groups.reduce((sum, g) => sum + g.length, 0),
    sizes: groups.map(g => g.length),
    repeats,
    freshPairs: fresh,
    colleaguePairs: colleagues,
    freshRate: totalPairs ? fresh / totalPairs : 1
  };
}

// --- small helpers ---------------------------------------------------------

function shuffleIdx(n, rng) {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function shuffleArray(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deterministic PRNG so any round can be reproduced from its seed.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
