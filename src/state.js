import crypto from 'node:crypto';
import { assignRound, describe, pairKey, placeLatecomer, planGroups } from './assign.js';
import {
  DEFAULT_COLOR_COUNT,
  DEFAULT_ROUND_MINUTES,
  PALETTE,
  QUESTIONS
} from './config.js';
import { save } from './store.js';

// ---------------------------------------------------------------------------
// The live event.
//
// One event at a time, held in memory, snapshotted to the store. Everything
// the phones and the operator console read is derived from this.
// ---------------------------------------------------------------------------

const listeners = new Set();

export const event = {
  name: 'Networking',
  status: 'setup',            // setup -> running -> (paused) -> ended
  colorCount: DEFAULT_COLOR_COUNT,
  roundMinutes: DEFAULT_ROUND_MINUTES,
  huddleSize: 6,
  useHuddles: true,
  // Icebreaker prompts are off unless the host switches them on. Left to
  // themselves people introduce themselves fine; a prompt on every screen can
  // make the room feel scripted. The host decides, live.
  showQuestions: false,
  roundIndex: 0,              // 0 = not started yet; first round is 1
  roundStartedAt: null,
  roundEndsAt: null,
  pausedRemainingMs: null,
  // A guest silent for this long across rounds stops being counted. Generous
  // on purpose: phones go in pockets and mobile browsers throttle timers, and
  // dropping someone who is standing right there is worse than counting a
  // straggler who left.
  absentAfterMinutes: 25
};

/** id -> guest */
export const participants = new Map();
/** token -> id */
const tokens = new Map();
/** Yarnoo member id -> guest id. One profile is one seat, however many phones sign in with it. */
const byYarnoo = new Map();
/** pairKey -> rounds shared */
export const meetings = new Map();
/** guest id -> Set of everyone they have shared a huddle with, for the wrap-up. */
const metIndex = new Map();

function indexMeeting(aId, bId) {
  if (!metIndex.has(aId)) metIndex.set(aId, new Set());
  if (!metIndex.has(bId)) metIndex.set(bId, new Set());
  metIndex.get(aId).add(bId);
  metIndex.get(bId).add(aId);
}

/** The round on the floor right now. */
export let round = null;

// --- guests ----------------------------------------------------------------

/**
 * A comparable key for a company name, in any script. Strips accents, Arabic
 * harakat and tatweel, then compares letters and digits only - so "فرقة النور"
 * and "فرقةُ النور" are the same company, and Arabic names are kept apart as
 * reliably as Latin ones.
 */
const normaliseCompany = value =>
  (value || '').normalize('NFKD').replace(/[\p{M}ـ]/gu, '').normalize('NFKC')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || null;

/**
 * Seat a guest. `yarnoo` is the member profile Yarnoo vouched for; without it
 * this is a walk-in who typed their own name at the door.
 */
export function join({ name, company, role, yarnoo = null }) {
  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const guest = {
    id,
    token,
    name: (name || '').trim().slice(0, 60) || 'Guest',
    company: (company || '').trim().slice(0, 80),
    role: (role || '').trim().slice(0, 80),
    companyKey: normaliseCompany(company),
    yarnooId: yarnoo?.id || null,
    avatarUrl: yarnoo?.avatarUrl || '',
    profileUrl: yarnoo?.profileUrl || '',
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    metCount: 0,       // distinct people talked with so far
    color: null,       // colour index for the current round
    group: null,       // huddle index for the current round
    history: []        // colour index per round played
  };
  participants.set(id, guest);
  tokens.set(token, id);
  if (guest.yarnooId) byYarnoo.set(guest.yarnooId, id);

  // Someone who arrives mid-round should not have to wait ten minutes to be
  // part of the night. Seat them straight away.
  if (event.status === 'running' && round) seatLatecomer(guest);

  persist();
  broadcast();
  return guest;
}

/**
 * Seat a Yarnoo member, or hand back the seat they already have. Signing in
 * again - a second phone, a cleared browser, a dead battery and a borrowed
 * phone - must not create a second guest: the matcher would put the same
 * person in two circles and count every meeting twice.
 */
export function joinYarnoo(profile) {
  const existing = participants.get(byYarnoo.get(profile.id));
  if (existing) {
    // Keep their seat and history, and take whatever Yarnoo now says about
    // them - but never blank a field because this sign-in did not carry it.
    // A profile lookup that is down falls back to a token that may hold only
    // the id, and that must not strip a member's photo, link or company.
    existing.name = profile.name || existing.name;
    existing.role = profile.role || existing.role;
    existing.avatarUrl = profile.avatarUrl || existing.avatarUrl;
    existing.profileUrl = profile.profileUrl || existing.profileUrl;
    if (profile.company) {
      existing.company = profile.company;
      existing.companyKey = normaliseCompany(profile.company);
    }
    existing.lastSeen = Date.now();
    // Back after missing rotations (a dead battery, a borrowed phone): seat
    // them now, like a late arrival, rather than at the next rotation.
    if (needsSeat(existing)) seatLatecomer(existing);
    persist();
    broadcast();
    return existing;
  }
  if (event.status === 'ended') return null;
  return join({ name: profile.name, company: profile.company, role: profile.role, yarnoo: profile });
}

/** In the room while a round is running, but in none of its groups. */
const needsSeat = guest =>
  event.status === 'running' && !!round && !round.groups.some(g => g.includes(guest.id));

/**
 * Seat a returning guest who missed the last rotation. Called when a phone
 * comes back (an API poll or a fresh socket) - never from inside a broadcast,
 * since it broadcasts itself.
 */
export function reseat(guest) {
  if (!guest || !needsSeat(guest)) return false;
  seatLatecomer(guest);
  persist();
  broadcast();
  return true;
}

export function bytoken(token) {
  const id = tokens.get(token);
  return id ? participants.get(id) : null;
}

export function touch(token) {
  const guest = bytoken(token);
  if (guest) guest.lastSeen = Date.now();
  return guest;
}

export function removeGuest(id) {
  const guest = participants.get(id);
  if (!guest) return false;
  tokens.delete(guest.token);
  if (guest.yarnooId && byYarnoo.get(guest.yarnooId) === id) byYarnoo.delete(guest.yarnooId);
  participants.delete(id);
  if (round) round.groups.forEach(g => {
    const at = g.indexOf(id);
    if (at >= 0) g.splice(at, 1);
  });
  persist();
  broadcast();
  return true;
}

/**
 * Note that two guests have shared a group. Distinct-people counts are kept
 * incrementally: recomputing them meant scanning every pair for every guest on
 * every broadcast, which is fine for forty people and not for four hundred.
 */
function recordMeeting(aId, bId) {
  const key = pairKey(aId, bId);
  const seen = meetings.get(key) || 0;
  meetings.set(key, seen + 1);
  if (seen === 0) {
    indexMeeting(aId, bId);
    const a = participants.get(aId);
    const b = participants.get(bId);
    if (a) a.metCount = (a.metCount || 0) + 1;
    if (b) b.metCount = (b.metCount || 0) + 1;
  }
}

/** Guests we still believe are in the room. */
export function activeGuests() {
  const cutoff = Date.now() - event.absentAfterMinutes * 60_000;
  return [...participants.values()].filter(g => g.lastSeen >= cutoff);
}

// --- rounds ----------------------------------------------------------------

function seatLatecomer(guest) {
  const groupIds = round.groups;
  const groups = groupIds.map(ids => ids.map(id => participants.get(id)).filter(Boolean));
  const g = placeLatecomer(
    { id: guest.id, companyKey: guest.companyKey, lastColor: null },
    groups,
    meetings,
    round.groupColor
  );
  groupIds[g].push(guest.id);
  guest.group = g;
  guest.color = round.groupColor[g];
  // They have now met everyone already standing there.
  for (const other of groups[g]) {
    if (other.id === guest.id) continue;
    recordMeeting(guest.id, other.id);
  }
}

/**
 * Cut the room for the next round and put it on the floor.
 * The wheel on each phone is theatre: the answer is decided here, first.
 */
export function nextRound() {
  const roster = activeGuests();
  const colorCount = Math.min(event.colorCount, PALETTE.length);

  const plan = event.useHuddles
    ? planGroups(Math.max(roster.length, colorCount), colorCount, event.huddleSize)
    : { groupCount: colorCount, groupColor: Int32Array.from({ length: colorCount }, (_, i) => i), huddlesPerColor: 1 };

  // Budget scales with the room but stays short enough that the rotation feels
  // instant on the floor.
  const budgetMs = Math.min(1200, 250 + roster.length * 3);

  const { groups, stats, ms } = assignRound(
    roster.map(g => ({ id: g.id, companyKey: g.companyKey, lastColor: g.color })),
    plan.groupCount,
    meetings,
    {
      roundIndex: event.roundIndex,
      budgetMs,
      seed: Date.now(),
      groupColor: plan.groupColor
    }
  );

  event.roundIndex += 1;
  event.roundStartedAt = Date.now();
  event.roundEndsAt = event.roundStartedAt + event.roundMinutes * 60_000;
  event.pausedRemainingMs = null;

  round = {
    index: event.roundIndex,
    groups: groups.map(g => g.map(p => p.id)),
    groupColor: Array.from(plan.groupColor),
    huddlesPerColor: plan.huddlesPerColor,
    stats,
    computedMs: ms
  };

  // Anyone left out of this round (gone quiet) loses last round's colour, so
  // their phone never sends them to a circle they are no longer part of.
  // If they come back, reseat() places them like a late arrival.
  const seated = new Set(roster.map(g => g.id));
  for (const g of participants.values()) {
    if (!seated.has(g.id)) { g.color = null; g.group = null; }
  }

  // Commit: everyone in a huddle has now met everyone else in it.
  groups.forEach((group, gi) => {
    const color = plan.groupColor[gi];
    for (let i = 0; i < group.length; i++) {
      const a = participants.get(group[i].id);
      if (!a) continue;
      a.color = color;
      a.group = gi;
      a.history.push(color);
      for (let j = i + 1; j < group.length; j++) {
        recordMeeting(group[i].id, group[j].id);
      }
    }
  });

  console.log(
    `[round ${round.index}] ${stats.people} guests, ${plan.groupCount} huddles across ${colorCount} colours, ` +
    `${stats.repeats} repeat pairs, ${stats.colleaguePairs} colleague pairs, ${ms}ms`
  );

  persist();
  broadcast();
  return round;
}

export function start() {
  if (event.status === 'running') return round;
  event.status = 'running';
  return nextRound();
}

export function pause() {
  if (event.status !== 'running') return;
  event.status = 'paused';
  event.pausedRemainingMs = Math.max(0, event.roundEndsAt - Date.now());
  persist();
  broadcast();
}

export function resume() {
  if (event.status !== 'paused') return;
  event.status = 'running';
  event.roundEndsAt = Date.now() + (event.pausedRemainingMs ?? event.roundMinutes * 60_000);
  event.pausedRemainingMs = null;
  persist();
  broadcast();
}

/** Add or remove time from the round in progress. */
export function nudgeRound(deltaMs) {
  if (!event.roundEndsAt) return;
  if (event.status === 'paused') {
    event.pausedRemainingMs = Math.max(5000, (event.pausedRemainingMs ?? 0) + deltaMs);
  } else {
    event.roundEndsAt = Math.max(Date.now() + 5000, event.roundEndsAt + deltaMs);
  }
  persist();
  broadcast();
}

export function endEvent() {
  event.status = 'ended';
  event.roundEndsAt = null;
  persist();
  broadcast();
}

export function resetEvent() {
  participants.clear();
  tokens.clear();
  byYarnoo.clear();
  meetings.clear();
  metIndex.clear();
  round = null;
  event.status = 'setup';
  event.roundIndex = 0;
  event.roundStartedAt = null;
  event.roundEndsAt = null;
  event.pausedRemainingMs = null;
  persist();
  broadcast();
}

export function configure(patch) {
  if (patch.name !== undefined) event.name = String(patch.name).slice(0, 80);
  // An empty or nonsense value (a select with nothing chosen sends 0) must not
  // silently shrink the room to two circles.
  if (patch.colorCount !== undefined && Number(patch.colorCount) >= 1) {
    event.colorCount = clamp(Math.round(Number(patch.colorCount)), 2, PALETTE.length);
  }
  if (patch.roundMinutes !== undefined) {
    event.roundMinutes = clamp(Number(patch.roundMinutes), 1, 60);
  }
  if (patch.huddleSize !== undefined) {
    event.huddleSize = clamp(Math.round(patch.huddleSize), 2, 20);
  }
  if (patch.useHuddles !== undefined) event.useHuddles = !!patch.useHuddles;
  if (patch.showQuestions !== undefined) event.showQuestions = !!patch.showQuestions;
  if (patch.absentAfterMinutes !== undefined) {
    event.absentAfterMinutes = clamp(Number(patch.absentAfterMinutes), 2, 240);
  }
  persist();
  broadcast();
  return event;
}

/** Called every second by the server clock. */
export function tick() {
  if (event.status !== 'running' || !event.roundEndsAt) return false;
  if (Date.now() < event.roundEndsAt) return false;
  nextRound();
  return true;
}

// --- views -----------------------------------------------------------------

export function colors() {
  return PALETTE.slice(0, Math.min(event.colorCount, PALETTE.length));
}

function questionFor(roundIndex, groupIndex) {
  // Same prompt for everyone in a huddle, different prompt per huddle, and a
  // fresh one every round.
  return QUESTIONS[(roundIndex * 7 + groupIndex * 3) % QUESTIONS.length];
}

/** What one guest's phone shows right now. */
export function guestView(guest) {
  const palette = colors();
  const base = {
    event: {
      name: event.name,
      status: event.status,
      roundIndex: event.roundIndex,
      roundEndsAt: event.status === 'paused' ? null : event.roundEndsAt,
      pausedRemainingMs: event.pausedRemainingMs,
      roundMinutes: event.roundMinutes
    },
    colors: palette,
    me: {
      id: guest.id,
      name: guest.name,
      company: guest.company,
      role: guest.role,
      avatarUrl: guest.avatarUrl || '',
      yarnoo: !!guest.yarnooId,
      rounds: guest.history.length
    }
  };

  if (event.status === 'ended') {
    return { ...base, assignment: null, metCount: metCountFor(guest.id), met: metList(guest.id) };
  }

  // No colour, or one outside the circles now in play (the host lowered the
  // count mid-round): wait for the next rotation rather than send a phone a
  // colour it cannot draw.
  if (event.status !== 'running' || !round || guest.color === null || !palette[guest.color]) {
    return { ...base, assignment: null, metCount: metCountFor(guest.id) };
  }

  const groupIds = round.groups[guest.group] || [];
  const huddle = groupIds
    .filter(id => id !== guest.id)
    .map(id => participants.get(id))
    .filter(Boolean)
    .map(card);

  // Which huddle within the colour, counting from 1, for calling out loud.
  const siblings = round.groupColor
    .map((c, gi) => ({ c, gi }))
    .filter(x => x.c === guest.color)
    .map(x => x.gi);

  return {
    ...base,
    assignment: {
      colorIndex: guest.color,
      color: palette[guest.color],
      huddleNumber: siblings.indexOf(guest.group) + 1,
      huddleCount: siblings.length,
      question: event.showQuestions ? questionFor(round.index, guest.group) : null,
      huddle
    },
    metCount: metCountFor(guest.id)
  };
}

function metCountFor(id) {
  return participants.get(id)?.metCount ?? 0;
}

/** How one guest appears on another guest's phone. */
const card = p => ({
  name: p.name,
  company: p.company,
  role: p.role,
  avatarUrl: p.avatarUrl || '',
  profileUrl: p.profileUrl || ''
});

/**
 * Everyone this guest shared a huddle with, for the wrap-up screen - the
 * point of signing in with Yarnoo is being able to find these people again.
 * Read from metIndex, so it costs the number of people met, not the size of
 * the whole pair log, on every broadcast after the end.
 */
function metList(id) {
  return [...(metIndex.get(id) || [])]
    .map(other => participants.get(other))
    .filter(Boolean)
    .map(card)
    .sort((x, y) => x.name.localeCompare(y.name));
}

/** Counts per colour, for the projector screen and the operator console. */
export function colorTotals() {
  const palette = colors();
  const totals = palette.map((c, i) => ({ ...c, index: i, count: 0, huddles: 0 }));
  if (!round) return totals;
  round.groups.forEach((ids, gi) => {
    const color = round.groupColor[gi];
    if (!totals[color]) return;
    totals[color].count += ids.length;
    if (ids.length) totals[color].huddles += 1;
  });
  return totals;
}

export function adminView() {
  const active = activeGuests();
  const distinct = meetings.size;
  const repeatPairs = [...meetings.values()].filter(v => v > 1).length;

  return {
    event: { ...event },
    store: { participants: participants.size, active: active.length },
    round: round
      ? {
          index: round.index,
          stats: round.stats,
          computedMs: round.computedMs,
          huddlesPerColor: round.huddlesPerColor
        }
      : null,
    colors: colorTotals(),
    quality: {
      distinctPairs: distinct,
      repeatPairs,
      // Average number of people each guest has actually talked with.
      avgMet: participants.size ? (2 * distinct) / participants.size : 0
    },
    guests: [...participants.values()]
      .sort((a, b) => b.joinedAt - a.joinedAt)
      .map(g => ({
        id: g.id,
        name: g.name,
        company: g.company,
        role: g.role,
        yarnooId: g.yarnooId || null,
        profileUrl: g.profileUrl || '',
        color: g.color,
        rounds: g.history.length,
        active: g.lastSeen >= Date.now() - event.absentAfterMinutes * 60_000,
        lastSeen: g.lastSeen
      }))
  };
}

export function screenView() {
  return {
    event: {
      name: event.name,
      status: event.status,
      roundIndex: event.roundIndex,
      roundEndsAt: event.status === 'paused' ? null : event.roundEndsAt,
      pausedRemainingMs: event.pausedRemainingMs
    },
    colors: colorTotals(),
    guests: participants.size
  };
}

/** Post-event export for the client. */
export function exportCsv() {
  const rows = [['name', 'company', 'role', 'yarnoo_id', 'yarnoo_profile', 'joined_at', 'rounds_played', 'people_met', 'colours']];
  for (const g of participants.values()) {
    rows.push([
      g.name,
      g.company,
      g.role,
      g.yarnooId || '',
      g.profileUrl || '',
      new Date(g.joinedAt).toISOString(),
      g.history.length,
      metCountFor(g.id),
      g.history.map(i => PALETTE[i]?.name ?? i).join(' > ')
    ]);
  }
  return rows
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

// --- plumbing --------------------------------------------------------------

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('[broadcast]', err.message); }
  }
}

function snapshot() {
  return {
    version: 1,
    event,
    round,
    participants: [...participants.values()],
    meetings: [...meetings.entries()]
  };
}

export function persist() {
  save(snapshot());
}

export function hydrate(data) {
  if (!data || data.version !== 1) return false;
  Object.assign(event, data.event || {});
  round = data.round || null;
  participants.clear();
  tokens.clear();
  byYarnoo.clear();
  meetings.clear();
  for (const g of data.participants || []) {
    participants.set(g.id, g);
    tokens.set(g.token, g.id);
    if (g.yarnooId) byYarnoo.set(g.yarnooId, g.id);
  }
  for (const [key, count] of data.meetings || []) meetings.set(key, count);

  // Rebuild the per-guest counters and the wrap-up index from the pair log,
  // so a snapshot taken before either existed still restores correctly.
  metIndex.clear();
  for (const g of participants.values()) g.metCount = 0;
  for (const key of meetings.keys()) {
    const sep = key.indexOf('|');
    indexMeeting(key.slice(0, sep), key.slice(sep + 1));
    const a = participants.get(key.slice(0, sep));
    const b = participants.get(key.slice(sep + 1));
    if (a) a.metCount++;
    if (b) b.metCount++;
  }

  // A snapshot written by a build with a bigger palette (the Ranna build had
  // eight colours) can point at colours that no longer exist. Keep the guests
  // and their meetings, drop the stale assignment, and re-cut the room.
  event.colorCount = clamp(Math.round(Number(event.colorCount)), 2, PALETTE.length);
  const stale = (round?.groupColor || []).some(c => c >= PALETTE.length) ||
    [...participants.values()].some(g => g.color !== null && g.color >= PALETTE.length);
  if (stale) {
    console.log('[hydrate] snapshot uses colours outside the current palette - re-cutting the room');
    for (const g of participants.values()) { g.color = null; g.group = null; }
    round = null;
    if (event.status === 'running') nextRound();
    else if (event.status === 'paused') event.status = 'setup';
  }

  // A restart must not silently swallow round time that already elapsed.
  if (event.status === 'running' && event.roundEndsAt && event.roundEndsAt < Date.now()) {
    console.log('[hydrate] round expired while we were down - rotating');
    nextRound();
  }
  console.log(`[hydrate] ${participants.size} guests, round ${event.roundIndex}, status ${event.status}`);
  return true;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
