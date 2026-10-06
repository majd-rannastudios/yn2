import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Yarnoo Supabase — server only.
//
// SUPABASE_SERVICE_ROLE_KEY never leaves this process. The Vite client talks
// only to our Express routes; those look up RSVPs by email/phone, seat guests,
// and write favorites. Account sign-up / sign-in stay on the main platform.
// ---------------------------------------------------------------------------

const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const eventName = process.env.SUPABASE_EVENT_NAME || 'YN2';
const requireCheckin = process.env.SUPABASE_REQUIRE_CHECKIN === '1';
const profileBase = (process.env.YARNOO_PROFILE_BASE || 'https://yarnoo.com').replace(/\/$/, '');

const MODES = ['off', 'optional', 'required'];

export const config = {
  enabled: Boolean(url && serviceKey),
  eventName,
  requireCheckin,
  mode: resolveMode()
};

function resolveMode() {
  const asked = (process.env.SUPABASE_AUTH || '').toLowerCase();
  if (asked && !MODES.includes(asked)) {
    throw new Error(`[supabase] SUPABASE_AUTH must be one of ${MODES.join(', ')} — got "${process.env.SUPABASE_AUTH}"`);
  }
  if (asked) return asked;
  return url && serviceKey ? 'optional' : 'off';
}

let admin = null;

export function assertConfigured() {
  if (config.mode === 'off') {
    if (url || serviceKey) {
      console.warn('[supabase] partial credentials ignored — set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or unset both');
    }
    console.log('[supabase] auth off');
    return;
  }
  if (!url || !serviceKey) {
    throw new Error('[supabase] SUPABASE_AUTH needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-only — never put the service role in the client)');
  }
  if (serviceKey.startsWith('eyJ') === false && serviceKey.length < 20) {
    throw new Error('[supabase] SUPABASE_SERVICE_ROLE_KEY looks invalid');
  }
  console.log(`[supabase] auth ${config.mode}, event ${eventName}${requireCheckin ? ', check-in required' : ''}`);
}

function client() {
  if (!admin) {
    admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
  }
  return admin;
}

export function publicConfig() {
  return {
    auth: config.mode,
    eventName: config.enabled ? eventName : null,
    requireCheckin
  };
}

const lower = v => String(v || '').trim().toLowerCase();

/** Soft-normalise a phone toward E.164 digits for comparison. */
function phoneDigits(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  // Lebanon default if bare mobile
  if (/^3\d{7}$/.test(digits) || /^7\d{7}$/.test(digits)) return `+961${digits}`;
  if (/^0\d+$/.test(digits)) return `+961${digits.slice(1)}`;
  return digits.startsWith('961') ? `+${digits}` : digits;
}

/**
 * Find the YN2 (or configured) registration for this email/phone.
 * Returns null if not registered (or not checked in when required).
 */
export async function findRegistration({ email, phone } = {}) {
  const sb = client();
  const em = lower(email);
  const ph = phoneDigits(phone);

  let query = sb.from('event_registrations').select('id, full_name, email, phone, attendee_type, checked_in_at, hobbies').eq('event_name', eventName);

  if (em) query = query.eq('email', em);
  else if (ph) query = query.eq('phone', ph);
  else return null;

  const { data, error } = await query.maybeSingle();
  if (error) {
    // Unique contact might be stored with different phone formatting — fall back to ilike email only.
    if (em && error.code !== 'PGRST116') {
      const retry = await sb.from('event_registrations')
        .select('id, full_name, email, phone, attendee_type, checked_in_at, hobbies')
        .eq('event_name', eventName)
        .ilike('email', em)
        .maybeSingle();
      if (retry.error) throw new Error(retry.error.message);
      return gateRegistration(retry.data);
    }
    if (error.code === 'PGRST116') return null;
    throw new Error(error.message);
  }
  return gateRegistration(data);
}

function gateRegistration(row) {
  if (!row) return null;
  if (requireCheckin && !row.checked_in_at) {
    const err = new Error('Check in at the door first, then join with your email or phone.');
    err.code = 'not_checked_in';
    throw err;
  }
  return row;
}

/** Soft-match a public.users row by email (preferred) or phone. */
export async function findUserProfile({ email, phone, userId } = {}) {
  const sb = client();
  if (userId) {
    const { data, error } = await sb.from('users').select('id, name, email, profile_picture_url, phone_e164, main_artist_id').eq('id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return enrichUser(data);
  }
  const em = lower(email);
  if (em) {
    const { data, error } = await sb.from('users').select('id, name, email, profile_picture_url, phone_e164, main_artist_id').ilike('email', em).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return enrichUser(data);
  }
  const ph = phoneDigits(phone);
  if (ph) {
    const { data, error } = await sb.from('users').select('id, name, email, profile_picture_url, phone_e164, main_artist_id').eq('phone_e164', ph).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return enrichUser(data);
  }
  return null;
}

/**
 * Yarnoo photos live on artists more often than on users.profile_picture_url,
 * and main_artist_id is frequently unset — fall back to artists.user_id.
 */
async function findArtistForUser(user) {
  const select = 'title, profile_image, public_id';
  if (user.main_artist_id) {
    const { data } = await client().from('artists').select(select).eq('id', user.main_artist_id).maybeSingle();
    if (data) return data;
  }
  const { data: withPhoto } = await client()
    .from('artists')
    .select(select)
    .eq('user_id', user.id)
    .not('profile_image', 'is', null)
    .limit(1)
    .maybeSingle();
  if (withPhoto) return withPhoto;
  const { data: any } = await client()
    .from('artists')
    .select(select)
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  return any;
}

async function authAvatarUrl(userId) {
  try {
    const { data, error } = await client().auth.admin.getUserById(userId);
    if (error || !data?.user) return '';
    const meta = data.user.user_metadata || {};
    return meta.picture || meta.avatar_url || '';
  } catch {
    return '';
  }
}

async function enrichUser(user) {
  let role = '';
  let profileUrl = '';
  let avatarUrl = user.profile_picture_url || '';
  const artist = await findArtistForUser(user);
  if (artist) {
    role = artist.title || role;
    avatarUrl = artist.profile_image || avatarUrl;
    if (artist.public_id) profileUrl = `${profileBase}/${artist.public_id}`;
  }
  // OAuth sign-ups often leave users.profile_picture_url empty and only
  // stash the photo on auth metadata (Google picture / avatar_url).
  if (!avatarUrl) avatarUrl = await authAvatarUrl(user.id);
  return {
    id: user.id,
    name: user.name || '',
    email: user.email || '',
    avatarUrl,
    role,
    company: '',
    profileUrl
  };
}

/**
 * Seat someone by email or phone — no password.
 * Either identity is enough: a Yarnoo account (`users`) or a reservation
 * (`event_registrations` for this event). A match on both uses the account
 * for photo and favorites, and the reservation for the seat.
 */
export async function enrollByContact({ email, phone } = {}) {
  const em = lower(email);
  const ph = phoneDigits(phone);
  if (!em && !ph) {
    const err = new Error('Enter the email on your Yarnoo account, or the one you reserved with');
    err.code = 'invalid';
    throw err;
  }

  const reg = await findRegistration({ email: em || undefined, phone: ph || undefined });
  const matched = await findUserProfile({
    email: em || reg?.email,
    phone: ph || reg?.phone
  });

  if (!reg && !matched) {
    const err = new Error(
      `No Yarnoo account or reservation found for this ${em ? 'email' : 'phone'}.`
    );
    err.code = 'not_registered';
    throw err;
  }

  return {
    id: matched?.id || null,
    name: (matched?.name || reg?.full_name || 'Guest').slice(0, 60),
    role: (matched?.role || reg?.attendee_type || '').slice(0, 80),
    company: (matched?.company || '').slice(0, 80),
    avatarUrl: matched?.avatarUrl || '',
    profileUrl: matched?.profileUrl || '',
    registrationId: reg?.id || null
  };
}

/** List favorited user ids and registration ids for this member. */
export async function listFavoriteTargets(userId) {
  const { data, error } = await client()
    .from('favorites')
    .select('favorited_user_id, registration_id')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return {
    userIds: new Set((data || []).map(r => r.favorited_user_id).filter(Boolean)),
    registrationIds: new Set((data || []).map(r => r.registration_id).filter(Boolean))
  };
}

/**
 * Toggle a favorite. Prefer favorited_user_id; fall back to registration_id.
 * Returns { favorited: boolean }.
 */
export async function toggleFavorite(userId, { favoritedUserId, registrationId }) {
  if (favoritedUserId && favoritedUserId === userId) {
    const err = new Error('You cannot favorite yourself');
    err.code = 'self';
    throw err;
  }
  if (!favoritedUserId && !registrationId) {
    const err = new Error('That person cannot be favorited yet');
    err.code = 'no_target';
    throw err;
  }

  const sb = client();
  let existing;
  if (favoritedUserId) {
    const { data, error } = await sb.from('favorites')
      .select('id')
      .eq('user_id', userId)
      .eq('favorited_user_id', favoritedUserId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    existing = data;
  } else {
    const { data, error } = await sb.from('favorites')
      .select('id')
      .eq('user_id', userId)
      .eq('registration_id', registrationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    existing = data;
  }

  if (existing) {
    const { error } = await sb.from('favorites').delete().eq('id', existing.id);
    if (error) throw new Error(error.message);
    return { favorited: false };
  }

  const row = {
    user_id: userId,
    artist_id: null,
    favorited_user_id: favoritedUserId || null,
    job_id: null,
    registration_id: favoritedUserId ? null : registrationId
  };
  const { error } = await sb.from('favorites').insert(row);
  if (error) throw new Error(error.message);
  return { favorited: true };
}
