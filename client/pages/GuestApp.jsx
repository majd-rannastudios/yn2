import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo.jsx';
import { PersonRow } from '../components/PersonRow.jsx';
import { Sound } from '../sound.js';

const SIGNIN_ERRORS = {
  expired: 'That sign-in took too long. Tap Continue with Yarnoo again.',
  already_used: 'That sign-in link was already used. Tap Continue with Yarnoo again.',
  not_registered: 'Your Yarnoo account is not registered for this event. Check with the host at the door.',
  event_ended: 'This event has finished.',
  state_mismatch: 'Sign-in got crossed with another tab. Tap Continue with Yarnoo again.',
  access_denied: 'Sign-in was cancelled.'
};

/** Prefill from ?email= or ?phone= so RSVP / QR links can skip typing. */
function contactFromUrl() {
  const q = new URLSearchParams(location.search);
  const email = (q.get('email') || '').trim();
  const phone = (q.get('phone') || '').trim();
  if (email) return email;
  if (phone) return phone;
  return '';
}

function parseContact(raw) {
  const v = String(raw || '').trim();
  if (!v) return {};
  if (v.includes('@')) return { email: v };
  return { phone: v };
}

function wheelPaths(colors) {
  const n = colors.length;
  const step = 360 / n;
  return colors.map((c, i) => {
    const a0 = (i * step - 90 - step / 2) * Math.PI / 180;
    const a1 = ((i + 1) * step - 90 - step / 2) * Math.PI / 180;
    const large = step > 180 ? 1 : 0;
    const x0 = 100 + 96 * Math.cos(a0), y0 = 100 + 96 * Math.sin(a0);
    const x1 = 100 + 96 * Math.cos(a1), y1 = 100 + 96 * Math.sin(a1);
    return (
      <path
        key={c.hex + i}
        d={`M100,100 L${x0.toFixed(2)},${y0.toFixed(2)} A96,96 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`}
        fill={c.hex}
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    );
  });
}

export default function GuestApp() {
  const [screen, setScreen] = useState(() => localStorage.getItem('stw-token') ? 'wait' : 'join');
  const [token, setToken] = useState(() => localStorage.getItem('stw-token'));
  const [view, setView] = useState(null);
  const [shownRound, setShownRound] = useState(0);
  const [soundOn, setSoundOn] = useState(Sound.enabled);
  const [authError, setAuthError] = useState(null);
  const [showLookup, setShowLookup] = useState(false);
  const [showWalkin, setShowWalkin] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [eventEnded, setEventEnded] = useState(false);
  const [joining, setJoining] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [contact, setContact] = useState(contactFromUrl);
  const [overlay, setOverlay] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [spinLabel, setSpinLabel] = useState('Tap to spin');
  const [spinPulse, setSpinPulse] = useState(true);
  const [now, setNow] = useState(Date.now());

  const rotationRef = useRef(0);
  const wheelRef = useRef(null);
  const socketRef = useRef(null);
  const viewRef = useRef(null);
  const shownRoundRef = useRef(0);
  const spinningRef = useRef(false);
  const tickTimersRef = useRef([]);
  const landTimerRef = useRef(null);
  const tokenRef = useRef(token);

  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { shownRoundRef.current = shownRound; }, [shownRound]);
  useEffect(() => { spinningRef.current = spinning; }, [spinning]);
  useEffect(() => { tokenRef.current = token; }, [token]);

  // Yarnoo handoff from URL fragment
  useEffect(() => {
    const handoff = new URLSearchParams(location.hash.slice(1));
    if (handoff.has('token') || handoff.has('auth_error')) {
      history.replaceState(null, '', location.pathname + location.search);
      if (handoff.get('token')) {
        const t = handoff.get('token');
        localStorage.setItem('stw-token', t);
        setToken(t);
        tokenRef.current = t;
        setScreen('wait');
      }
      const err = handoff.get('auth_error');
      if (err === 'event_ended') {
        setEventEnded(true);
        setShowLookup(false);
        setShowWalkin(false);
        setShowForm(false);
      } else if (err) {
        setAuthError(SIGNIN_ERRORS[err] || 'We could not confirm your Yarnoo sign-in. Please try again.');
      }
    }
  }, []);

  // Join doors from config; also learn if the event is already over.
  useEffect(() => {
    let cancelled = false;
    const load = (tries = 0) => {
      fetch('/api/config', { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(`config ${r.status}`); return r.json(); })
        .then(cfg => {
          if (cancelled) return;
          if (cfg.event?.status === 'ended') {
            setEventEnded(true);
            setShowLookup(false);
            setShowWalkin(false);
            setShowForm(false);
            return;
          }
          setEventEnded(false);
          const lookup = cfg.doors?.lookup ?? (cfg.supabase?.auth && cfg.supabase.auth !== 'off');
          const walkin = cfg.doors?.walkin ?? (cfg.auth !== 'required');
          if (lookup) {
            setShowLookup(true);
            setShowWalkin(!!walkin);
            setShowForm(false);
            return;
          }
          // No RSVP lookup — walk-in name form only.
          setShowLookup(false);
          setShowWalkin(false);
          setShowForm(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (tries < 3) return setTimeout(() => load(tries + 1), 800 * 2 ** tries);
          setShowLookup(true);
          setShowWalkin(true);
        });
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const apply = useCallback((next, { firstLoad = false } = {}) => {
    const previous = viewRef.current;
    viewRef.current = next;
    setView(next);

    if (next.event.status === 'ended') {
      setOverlay(false);
      if (previous && previous.event.status !== 'ended') Sound.finish();
      setScreen('wait');
      return;
    }

    if (!next.assignment) {
      setOverlay(false);
      setScreen('wait');
      return;
    }

    const roundChanged = next.event.roundIndex !== shownRoundRef.current;
    if (spinningRef.current) return;

    if (roundChanged) {
      const midEvent = previous?.assignment && previous.event.roundIndex !== next.event.roundIndex;
      if (midEvent && !firstLoad) {
        Sound.rotate();
        setOverlay(true);
      } else {
        setSpinLabel('Tap to spin');
        setSpinPulse(true);
        setSpinning(false);
        setScreen('wheel');
      }
    } else {
      setScreen('result');
    }
  }, []);

  const refresh = useCallback(async () => {
    const t = tokenRef.current;
    if (!t) return;
    try {
      const res = await fetch(`/api/me?token=${t}`);
      if (res.status === 404) {
        localStorage.removeItem('stw-token');
        location.reload();
        return;
      }
      apply(await res.json());
    } catch { /* the socket retries on its own */ }
  }, [apply]);

  const connect = useCallback(() => {
    const t = tokenRef.current;
    if (!t) return;
    if (socketRef.current) {
      try { socketRef.current.close(); } catch { /* ignore */ }
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?role=guest&token=${t}`);
    socketRef.current = socket;
    socket.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'guest') apply(msg.data);
    };
    socket.onclose = () => {
      setTimeout(() => {
        if (tokenRef.current) connect();
      }, 2500 + Math.random() * 2500);
    };
    socket.onerror = () => socket.close();
  }, [apply]);

  // Boot / resume
  useEffect(() => {
    if (!token) return;
    setScreen('wait');
    refresh().then(connect);
  }, [token, refresh, connect]);

  useEffect(() => {
    const resumeSeat = () => {
      const stored = localStorage.getItem('stw-token');
      if (!stored || stored === tokenRef.current) return false;
      localStorage.setItem('stw-token', stored);
      setToken(stored);
      tokenRef.current = stored;
      setScreen('wait');
      return true;
    };
    addEventListener('pageshow', resumeSeat);
    return () => removeEventListener('pageshow', resumeSeat);
  }, []);

  // Poll + heartbeat + visibility
  useEffect(() => {
    const poll = setInterval(() => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) refresh();
    }, 12000);
    const beat = setInterval(() => {
      if (tokenRef.current) {
        navigator.sendBeacon?.('/api/heartbeat', new Blob(
          [JSON.stringify({ token: tokenRef.current })], { type: 'application/json' }
        ));
      }
    }, 45000);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) connect();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(poll);
      clearInterval(beat);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh, connect]);

  // Countdown ticker
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => {
    tickTimersRef.current.forEach(clearTimeout);
    clearTimeout(landTimerRef.current);
    try { socketRef.current?.close(); } catch { /* ignore */ }
  }, []);

  function toggleSound() {
    Sound.toggle();
    setSoundOn(Sound.enabled);
  }

  async function onJoin(e) {
    e.preventDefault();
    const stored = localStorage.getItem('stw-token');
    if (stored && stored !== tokenRef.current) {
      setToken(stored);
      tokenRef.current = stored;
      setScreen('wait');
      return;
    }
    Sound.unlock();
    setJoining(true);
    const form = new FormData(e.target);
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.get('name'),
          company: form.get('company'),
          role: form.get('role')
        })
      });
      const data = await res.json();
      if (res.status === 403) {
        setShowForm(false);
        setShowLookup(true);
        setShowWalkin(false);
        setAuthError(data.error);
        setJoining(false);
        return;
      }
      if (res.status === 409 || /has finished/i.test(data.error || '')) {
        setEventEnded(true);
        setShowLookup(false);
        setShowWalkin(false);
        setShowForm(false);
        setJoining(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not join');
      localStorage.setItem('stw-token', data.token);
      setToken(data.token);
      tokenRef.current = data.token;
      apply(data.view, { firstLoad: true });
      connect();
    } catch (err) {
      alert(err.message);
      setJoining(false);
    }
  }

  async function onEnroll(e) {
    e.preventDefault();
    Sound.unlock();
    setEnrolling(true);
    setAuthError(null);
    const body = parseContact(contact);
    try {
      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 || /has finished/i.test(data.error || '')) {
          setEventEnded(true);
          setShowLookup(false);
          setShowWalkin(false);
          setShowForm(false);
          setEnrolling(false);
          return;
        }
        throw new Error(data.error || 'Could not find your RSVP');
      }
      localStorage.setItem('stw-token', data.token);
      setToken(data.token);
      tokenRef.current = data.token;
      // Drop the prefill from the URL once seated.
      if (location.search) history.replaceState(null, '', location.pathname);
      apply(data.view, { firstLoad: true });
      connect();
    } catch (err) {
      const msg = err.message || '';
      setAuthError(
        /failed to fetch|networkerror|load failed/i.test(msg)
          ? 'Could not reach the event server. Refresh and try again.'
          : msg
      );
      setEnrolling(false);
    }
  }

  async function onFavorite(person) {
    const t = tokenRef.current;
    if (!t || !person?.id) return;
    try {
      const res = await fetch('/api/favorite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t, targetId: person.id })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not favorite');
      if (data.view) apply(data.view);
    } catch (err) {
      alert(err.message);
    }
  }

  function spinTo(colorIndex, colorCount, onDone) {
    const wheel = wheelRef.current;
    if (!wheel) return;
    tickTimersRef.current.forEach(clearTimeout);
    tickTimersRef.current = [];
    clearTimeout(landTimerRef.current);

    const step = 360 / colorCount;
    const jitter = (Math.random() - 0.5) * step * 0.5;
    const target = -(colorIndex * step) + jitter;
    const turns = 5 + Math.floor(Math.random() * 2);
    const current = ((rotationRef.current % 360) + 360) % 360;
    rotationRef.current += turns * 360 + (((target - current) % 360) + 360) % 360;

    wheel.classList.add('spinning');
    requestAnimationFrame(() => { wheel.style.transform = `rotate(${rotationRef.current}deg)`; });
    Sound.spin();

    let at = 120;
    let gap = 90;
    while (at < 4300) {
      tickTimersRef.current.push(setTimeout(() => Sound.tick(), at));
      at += gap;
      gap *= 1.14;
    }
    landTimerRef.current = setTimeout(() => {
      Sound.land();
      onDone();
    }, 4700);
  }

  function onSpin() {
    const v = viewRef.current;
    if (!v?.assignment) return;
    setSpinPulse(false);
    setSpinLabel('Spinning…');
    setSpinning(true);
    spinningRef.current = true;
    spinTo(v.assignment.colorIndex, v.colors.length, () => {
      spinningRef.current = false;
      setSpinning(false);
      setSpinLabel('Tap to spin');
      const latest = viewRef.current;
      if (!latest?.assignment) {
        apply(latest);
        return;
      }
      setShownRound(latest.event.roundIndex);
      shownRoundRef.current = latest.event.roundIndex;
      setScreen('result');
    });
  }

  function dismissOverlay() {
    setOverlay(false);
    setSpinLabel('Tap to spin');
    setSpinPulse(true);
    setScreen('wheel');
  }

  // Timer paint values
  const ends = view?.event?.roundEndsAt;
  let timerText = '—';
  let urgent = false;
  let barPct = 100;
  if (view?.event?.status === 'paused') {
    timerText = 'Paused';
  } else if (ends) {
    const left = Math.max(0, ends - now);
    const total = (view.event.roundMinutes || 10) * 60000;
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    timerText = `${m}:${String(s).padStart(2, '0')}`;
    urgent = left < 60000;
    barPct = Math.max(0, Math.min(100, (left / total) * 100));
  }

  const a = view?.assignment;
  const ended = view?.event?.status === 'ended';
  const paused = view?.event?.status === 'paused';
  const met = view?.met || [];

  return (
    <>
      <div className="wrap">
        <div className="topbar">
          <div className="brand-logo"><BrandLogo /></div>
          <button className={`sound-btn${soundOn ? ' on' : ''}`} type="button" onClick={toggleSound}>
            {soundOn ? '♪ Sound on' : '♪ Sound off'}
          </button>
        </div>

        <section className={`screen${screen === 'join' ? ' on' : ''}`} id="screen-join">
          <div className="join-hero">
            <div className="eyebrow hero-eyebrow">Yarnoo Community</div>
            <h1 className="hero-title">Spin The Wheel<span>Colors</span></h1>
            <p className="hero-sub">Spin for a colour, walk to that circle, and meet the people waiting there. New colour every few minutes.</p>
          </div>

          <div className="join-spacer" aria-hidden="true" />

          {eventEnded ? (
            <div className="join-ended">
              <h2>That is a wrap</h2>
              <p className="muted">This event has finished. Thanks for spinning with Yarnoo.</p>
            </div>
          ) : (
            <>
              {authError && <p className="auth-error" role="alert">{authError}</p>}

              {showLookup && !showForm && (
                <div className="signin">
                  <form className="contact-door" onSubmit={onEnroll}>
                    <div className="field">
                      <label htmlFor="f-contact">Join with your Yarnoo email, or the email you reserved with</label>
                      <input
                        id="f-contact"
                        name="contact"
                        autoComplete="username"
                        required
                        maxLength={120}
                        placeholder="Yarnoo account or reservation"
                        value={contact}
                        onChange={e => setContact(e.target.value)}
                      />
                    </div>
                    <button className="block" type="submit" disabled={enrolling}>
                      {enrolling ? 'Looking up…' : 'Continue'}
                    </button>
                  </form>
                  {showWalkin && (
                    <div className="door-or">
                      <span>or</span>
                      <p className="door-hint">No Yarnoo account? Join without one.</p>
                      <button
                        className="ghost block"
                        type="button"
                        onClick={() => { setShowForm(true); setAuthError(null); }}
                      >
                        Join as a guest
                      </button>
                    </div>
                  )}
                </div>
              )}

              {showForm && (
                <form onSubmit={onJoin}>
                  {showLookup && (
                    <button
                      className="ghost block back-door"
                      type="button"
                      onClick={() => { setShowForm(false); setAuthError(null); }}
                    >
                      ← Back to email or phone
                    </button>
                  )}
                  <div className="field">
                    <label htmlFor="f-name">Your name</label>
                    <input id="f-name" name="name" autoComplete="given-name" required maxLength={60} placeholder="e.g. Sara" />
                  </div>
                  <div className="field">
                    <label htmlFor="f-company">Company <span className="muted">(optional)</span></label>
                    <input id="f-company" name="company" autoComplete="organization" maxLength={80} placeholder="e.g. Yarnoo" />
                  </div>
                  <div className="field">
                    <label htmlFor="f-role">Role <span className="muted">(optional)</span></label>
                    <input id="f-role" name="role" autoComplete="organization-title" maxLength={80} placeholder="e.g. Singer, DJ, Event planner" />
                  </div>
                  <button className="block" type="submit" disabled={joining}>{joining ? 'Joining…' : 'Join the room'}</button>
                  <p className="consent">If you add a company, we use it only to seat you away from your own colleagues, and to show your name to the small group you are matched with. Nothing is shared beyond this event.</p>
                </form>
              )}
            </>
          )}
        </section>

        <section className={`screen${screen === 'wheel' ? ' on' : ''}`} id="screen-wheel">
          <div className="wheel-stage">
            <div className="eyebrow">Round {view?.event?.roundIndex || 1}</div>
            <div className="wheel-holder">
              <div className="pointer" />
              <svg className="wheel" ref={wheelRef} viewBox="0 0 200 200" aria-hidden="true">
                {view?.colors ? wheelPaths(view.colors) : null}
              </svg>
              <div className="wheel-hub"><img src="/brand/yarnoo-mark-magenta.svg" alt="" /></div>
            </div>
            <button
              type="button"
              className={spinPulse ? 'pulse' : undefined}
              disabled={spinning}
              onClick={onSpin}
            >
              {spinLabel}
            </button>
            <p className="tap-hint">
              {(view?.event?.roundIndex || 1) > 1 ? 'A new colour is waiting for you.' : 'Your colour is waiting.'}
            </p>
          </div>
        </section>

        <section className={`screen${screen === 'result' ? ' on' : ''}`} id="screen-result">
          {a && (
            <>
              <div className="result-color" style={{ background: a.color.hex, color: a.color.ink }}>
                <div className="result-label">Go to the</div>
                <div className="result-name">{a.color.name}</div>
                <div className="result-huddle">
                  {a.huddleCount > 1 ? `circle · group ${a.huddleNumber} of ${a.huddleCount}` : 'circle'}
                </div>
              </div>

              <div className="timer-row">
                <div>
                  <div className="eyebrow">Round {view.event.roundIndex}</div>
                  <div className="muted" style={{ fontSize: 13 }}>until you move again</div>
                </div>
                <div className={`timer${urgent ? ' urgent' : ''}`}>{timerText}</div>
              </div>
              <div className="bar"><i style={{ width: `${barPct}%` }} /></div>

              {a.question ? <div className="question">{a.question}</div> : null}

              {a.huddle.length > 0 && (
                <div>
                  <div className="eyebrow" style={{ marginTop: 20 }}>Your group</div>
                  <ul className="people">
                    {a.huddle.map(p => <PersonRow key={p.id || p.name} person={p} color={a.color} onFavorite={onFavorite} />)}
                  </ul>
                </div>
              )}

              <div className="stat-strip">
                <div className="stat"><b>{view.metCount}</b><span>people met</span></div>
                <div className="stat"><b>{view.me.rounds}</b><span>rounds</span></div>
              </div>

              <p className="notice">
                {a.huddle.length
                  ? 'Say hello. You will be moved again shortly.'
                  : 'You are first here — more people are on their way.'}
              </p>
            </>
          )}
        </section>

        <section className={`screen${screen === 'wait' ? ' on' : ''}`} id="screen-wait">
          <div className="wheel-stage">
            <h2 style={{ fontSize: 30 }}>
              {ended ? 'That is a wrap' : paused ? 'Hold on' : 'You are in'}
            </h2>
            <p className="muted center" style={{ maxWidth: '26ch' }}>
              {ended
                ? `You met ${view?.metCount ?? 0} people across ${view?.me?.rounds ?? 0} rounds. Nicely done.`
                : paused
                  ? 'The host has paused the rotation. Keep talking.'
                  : 'Hold tight — the first spin starts when the host kicks things off.'}
            </p>
            <div className="stat-strip" style={{ width: '100%' }}>
              <div className="stat"><b>{view?.metCount ?? 0}</b><span>people met</span></div>
              <div className="stat"><b>{view?.me?.rounds ?? 0}</b><span>rounds</span></div>
            </div>
            {ended && met.length > 0 && (
              <div className="met-block">
                <div className="eyebrow">People you met</div>
                <ul className="people">
                  {met.map(p => (
                    <PersonRow key={p.id || p.name} person={p} color={{ hex: '#FFFFFF', ink: '#A51374' }} onFavorite={onFavorite} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <footer className="site-foot">
          <a href="https://yarnoo.com" target="_blank" rel="noopener noreferrer">yarnoo.com</a>
        </footer>
      </div>

      <div className={`overlay${overlay ? ' on' : ''}`}>
        <h2>Time to move</h2>
        <p>New colour, new people. Tap to see where you are going.</p>
        <button type="button" onClick={dismissOverlay}>Spin again</button>
      </div>
    </>
  );
}
