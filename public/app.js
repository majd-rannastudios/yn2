/* Spin The Wheel: Colors — guest app.
 *
 * The wheel is theatre. The server has already decided this guest's colour
 * before the phone animates anything; the spin just reveals it. That is the
 * only way circles stay even and people stop re-meeting each other. */

(() => {
  const $ = id => document.getElementById(id);
  const screens = {
    join: $('screen-join'),
    wheel: $('screen-wheel'),
    result: $('screen-result'),
    wait: $('screen-wait')
  };

  let token = localStorage.getItem('stw-token');
  let view = null;          // latest server view
  let shownRound = 0;       // last round this phone has revealed
  let rotation = 0;         // running wheel angle, so it never rewinds
  let socket = null;
  let ticker = null;
  let spinning = false;     // guard: never reset the wheel mid-spin

  const show = name => {
    for (const [key, el] of Object.entries(screens)) el.classList.toggle('on', key === name);
  };

  const sound = window.Sound;

  // Sound toggle, shown on every screen.
  const paintSoundBtn = () => {
    const btn = $('sound-btn');
    btn.classList.toggle('on', sound.enabled);
    btn.textContent = sound.enabled ? '♪ Sound on' : '♪ Sound off';
  };
  $('sound-btn').addEventListener('click', () => { sound.toggle(); paintSoundBtn(); });
  paintSoundBtn();

  // --- join ---------------------------------------------------------------

  // Coming back from Yarnoo sign-in: the server hands over this guest's token,
  // or the reason it could not, in the URL fragment. Take it and wipe the URL
  // so a token never sits in history or gets shared with a screenshot.
  const handoff = new URLSearchParams(location.hash.slice(1));
  if (handoff.has('token') || handoff.has('auth_error')) {
    history.replaceState(null, '', location.pathname + location.search);
    if (handoff.get('token')) {
      token = handoff.get('token');
      localStorage.setItem('stw-token', token);
    }
  }

  const SIGNIN_ERRORS = {
    expired: 'That sign-in took too long. Tap Continue with Yarnoo again.',
    already_used: 'That sign-in link was already used. Tap Continue with Yarnoo again.',
    not_registered: 'Your Yarnoo account is not registered for this event. Check with the host at the door.',
    event_ended: 'This event has finished.',
    state_mismatch: 'Sign-in got crossed with another tab. Tap Continue with Yarnoo again.',
    access_denied: 'Sign-in was cancelled.'
  };
  const authError = handoff.get('auth_error');
  if (authError) {
    $('auth-error').textContent = SIGNIN_ERRORS[authError] || 'We could not confirm your Yarnoo sign-in. Please try again.';
    $('auth-error').hidden = false;
  }

  // Which doors are open is the server's call: Yarnoo members only, members
  // plus walk-ins, or the plain form when Yarnoo sign-in is not set up.
  const showForm = () => { $('join-form').hidden = false; $('walkin-btn').hidden = true; };
  const loadConfig = (tries = 0) => fetch('/api/config', { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error(`config ${r.status}`); return r.json(); })
    .then(cfg => {
      if (cfg.auth === 'off') return showForm();
      $('signin').hidden = false;
      $('yarnoo-btn').href = cfg.signinPath || '/auth/yarnoo/start';
      $('walkin-btn').hidden = cfg.auth !== 'optional';
    })
    .catch(() => {
      // Venue wifi. Try again, then open both doors and let the server
      // decide: /auth/yarnoo/start comes straight back when sign-in is off,
      // and a members-only server turns a walk-in back to the Yarnoo door.
      if (tries < 3) return setTimeout(() => loadConfig(tries + 1), 800 * 2 ** tries);
      $('signin').hidden = false;
      $('walkin-btn').hidden = false;
    });
  loadConfig();
  $('walkin-btn').addEventListener('click', showForm);

  /** Pick up a seat this browser already has instead of joining a second time. */
  const resumeSeat = () => {
    const stored = localStorage.getItem('stw-token');
    if (!stored || stored === token) return false;
    token = stored;
    show('wait');
    refresh().then(connect);
    return true;
  };
  // Back from Yarnoo sign-in restores the old join page from the back/forward
  // cache, with no token in memory - but the seat is in storage.
  addEventListener('pageshow', resumeSeat);

  $('join-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (resumeSeat()) return;
    // First real gesture of the session - the only moment a browser will let
    // us open an audio context.
    sound.unlock();
    const btn = $('join-btn');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: $('f-name').value,
          company: $('f-company').value,
          role: $('f-role').value
        })
      });
      const data = await res.json();
      if (res.status === 403) {
        // Members only: send them to the Yarnoo door, not a dead end.
        $('join-form').hidden = true;
        $('signin').hidden = false;
        $('walkin-btn').hidden = true;
        $('auth-error').textContent = data.error;
        $('auth-error').hidden = false;
        btn.disabled = false;
        btn.textContent = 'Join the room';
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not join');
      token = data.token;
      localStorage.setItem('stw-token', token);
      apply(data.view, { firstLoad: true });
      connect();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
      btn.textContent = 'Join the room';
    }
  });

  // --- wheel --------------------------------------------------------------

  function drawWheel(colors) {
    const svg = $('wheel');
    const n = colors.length;
    const step = 360 / n;
    svg.innerHTML = colors.map((c, i) => {
      // Segment i is centred on the top when the wheel is rotated by
      // -(i * step + step / 2), which is what the spin below aims for.
      const a0 = (i * step - 90 - step / 2) * Math.PI / 180;
      const a1 = ((i + 1) * step - 90 - step / 2) * Math.PI / 180;
      const large = step > 180 ? 1 : 0;
      const x0 = 100 + 96 * Math.cos(a0), y0 = 100 + 96 * Math.sin(a0);
      const x1 = 100 + 96 * Math.cos(a1), y1 = 100 + 96 * Math.sin(a1);
      return `<path d="M100,100 L${x0.toFixed(2)},${y0.toFixed(2)} A96,96 0 ${large},1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${c.hex}" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round"/>`;
    }).join('');
  }

  function spinTo(colorIndex, colorCount, onDone) {
    const wheel = $('wheel');
    // Clear any ticks still queued from a previous spin.
    (spinTo._ticks || []).forEach(clearTimeout);
    spinTo._ticks = [];
    const step = 360 / colorCount;
    // Land the chosen segment under the pointer, plus a few full turns, plus a
    // little jitter so two people spinning side by side do not look scripted.
    const jitter = (Math.random() - 0.5) * step * 0.5;
    const target = -(colorIndex * step) + jitter;
    const turns = 5 + Math.floor(Math.random() * 2);
    const current = ((rotation % 360) + 360) % 360;
    rotation += turns * 360 + (((target - current) % 360) + 360) % 360;

    wheel.classList.add('spinning');
    requestAnimationFrame(() => { wheel.style.transform = `rotate(${rotation}deg)`; });
    sound.spin();

    // Ticks thinning out as the wheel slows, so the ear hears it decelerate
    // alongside the easing curve.
    clearTimeout(spinTo._t);
    let at = 120;
    let gap = 90;
    while (at < 4300) {
      spinTo._ticks.push(setTimeout(() => sound.tick(), at));
      at += gap;
      gap *= 1.14;
    }

    spinTo._t = setTimeout(() => {
      sound.land();
      onDone();
    }, 4700);
  }

  $('spin-btn').addEventListener('click', () => {
    if (!view?.assignment) return;
    const btn = $('spin-btn');
    btn.disabled = true;
    btn.classList.remove('pulse');
    btn.textContent = 'Spinning…';
    spinning = true;
    spinTo(view.assignment.colorIndex, view.colors.length, () => {
      spinning = false;
      btn.disabled = false;
      btn.textContent = 'Tap to spin';
      // The host paused or ended the night while the wheel was turning:
      // go where the event is now, not to a stale result.
      if (!view.assignment) return apply(view);
      shownRound = view.event.roundIndex;
      renderResult();
      show('result');
    });
  });

  $('overlay-btn').addEventListener('click', () => {
    $('overlay').classList.remove('on');
    prepareSpin();
  });

  function prepareSpin() {
    if (!view?.assignment) return;
    drawWheel(view.colors);
    $('wheel-eyebrow').textContent = `Round ${view.event.roundIndex}`;
    $('wheel-hint').textContent = view.event.roundIndex > 1
      ? 'A new colour is waiting for you.'
      : 'Your colour is waiting.';
    const btn = $('spin-btn');
    btn.disabled = false;
    btn.classList.add('pulse');
    btn.textContent = 'Tap to spin';
    show('wheel');
  }

  // --- result -------------------------------------------------------------

  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

  /**
   * One person in a group or in the wrap-up: their Yarnoo photo (initials until
   * it loads, or if there is none), name, role, and a link to their profile.
   * Built with DOM calls, never innerHTML - names and links are other people's
   * data.
   */
  function personRow(p, color) {
    const li = document.createElement('li');
    li.className = 'person';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = color.hex;
    avatar.style.color = color.ink;
    avatar.textContent = initials(p.name);
    if (p.avatarUrl) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => avatar.replaceChildren(img);
      img.src = p.avatarUrl;
    }

    const text = document.createElement('div');
    text.className = 'person-text';
    const name = document.createElement('div');
    name.className = 'person-name';
    name.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'person-meta';
    meta.textContent = [p.role, p.company].filter(Boolean).join(' · ');
    text.append(name, meta);
    li.append(avatar, text);

    if (p.profileUrl) {
      const link = document.createElement('a');
      link.className = 'person-link';
      link.href = p.profileUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${p.name} on Yarnoo`);
      link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
      li.append(link);
    }
    return li;
  }

  function renderResult() {
    const a = view.assignment;
    if (!a) return;

    const card = $('result-color');
    card.style.background = a.color.hex;
    card.style.color = a.color.ink;
    $('result-name').textContent = a.color.name;
    $('result-huddle').textContent = a.huddleCount > 1
      ? `circle · group ${a.huddleNumber} of ${a.huddleCount}`
      : 'circle';

    $('round-label').textContent = `Round ${view.event.roundIndex}`;
    // The host decides whether the room gets a prompt at all.
    $('question').style.display = a.question ? '' : 'none';
    $('question').textContent = a.question || '';

    const list = $('people');
    list.innerHTML = '';
    if (a.huddle.length === 0) {
      $('people-block').style.display = 'none';
    } else {
      $('people-block').style.display = '';
      for (const p of a.huddle) list.appendChild(personRow(p, a.color));
    }

    $('stat-met').textContent = view.metCount;
    $('stat-rounds').textContent = view.me.rounds;
    $('result-notice').textContent = a.huddle.length
      ? 'Say hello. You will be moved again shortly.'
      : 'You are first here — more people are on their way.';
    startTicker();
  }

  // --- countdown ----------------------------------------------------------

  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(paintTimer, 1000);
    paintTimer();
  }

  function paintTimer() {
    const ends = view?.event?.roundEndsAt;
    const timer = $('timer');
    if (!ends) {
      timer.textContent = view?.event?.status === 'paused' ? 'Paused' : '—';
      timer.classList.remove('urgent');
      return;
    }
    const left = Math.max(0, ends - Date.now());
    const total = (view.event.roundMinutes || 10) * 60000;
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
    timer.classList.toggle('urgent', left < 60000);
    $('bar').style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
  }

  // --- state --------------------------------------------------------------

  function apply(next, { firstLoad = false } = {}) {
    const previous = view;
    view = next;

    if (view.event.status === 'ended') {
      $('overlay').classList.remove('on');
      clearInterval(ticker);
      if (previous && previous.event.status !== 'ended') sound.finish();
      $('wait-title').textContent = 'That is a wrap';
      $('wait-text').textContent = `You met ${view.metCount} people across ${view.me.rounds} rounds. Nicely done.`;
      $('wait-met').textContent = view.metCount;
      $('wait-rounds').textContent = view.me.rounds;
      const met = view.met || [];
      $('met-block').hidden = met.length === 0;
      $('met-list').replaceChildren(...met.map(p => personRow(p, { hex: '#FFFFFF', ink: '#A51374' })));
      show('wait');
      return;
    }

    $('met-block').hidden = true;
    if (!view.assignment) {
      $('overlay').classList.remove('on');
      $('wait-title').textContent = view.event.status === 'paused' ? 'Hold on' : 'You are in';
      $('wait-text').textContent = view.event.status === 'paused'
        ? 'The host has paused the rotation. Keep talking.'
        : 'Hold tight — the first spin starts when the host kicks things off.';
      $('wait-met').textContent = view.metCount;
      $('wait-rounds').textContent = view.me.rounds;
      show('wait');
      return;
    }

    const roundChanged = view.event.roundIndex !== shownRound;

    // A broadcast lands every time anyone joins. If this phone is mid-spin,
    // leave it alone - restarting the animation would look broken.
    if (spinning) { paintTimer(); return; }

    if (roundChanged) {
      // A brand new round while the guest was already playing: interrupt them.
      const midEvent = previous?.assignment && previous.event.roundIndex !== view.event.roundIndex;
      if (midEvent && !firstLoad) {
        sound.rotate();
        $('overlay').classList.add('on');
      } else {
        prepareSpin();
      }
    } else {
      renderResult();
      show('result');
    }
    paintTimer();
  }

  // --- transport ----------------------------------------------------------

  function connect() {
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws?role=guest&token=${token}`);

    socket.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'guest') apply(msg.data);
    };
    socket.onopen = () => $('offline').classList.remove('on');
    socket.onclose = () => {
      $('offline').classList.add('on');
      // Venue wifi is never good. Back off, then try again.
      setTimeout(connect, 2500 + Math.random() * 2500);
    };
    socket.onerror = () => socket.close();
  }

  async function refresh() {
    if (!token) return;
    try {
      const res = await fetch(`/api/me?token=${token}`);
      if (res.status === 404) { // event was reset from the console
        localStorage.removeItem('stw-token');
        location.reload();
        return;
      }
      apply(await res.json());
      $('offline').classList.remove('on');
    } catch {
      $('offline').classList.add('on');
    }
  }

  // Belt and braces: the socket is primary, but phones sleep and venue wifi
  // drops, so poll as well and re-sync the moment the screen comes back.
  setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) refresh();
  }, 12000);

  setInterval(() => {
    if (token) navigator.sendBeacon?.('/api/heartbeat', new Blob(
      [JSON.stringify({ token })], { type: 'application/json' }
    ));
  }, 45000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh();
      if (!socket || socket.readyState !== WebSocket.OPEN) connect();
    }
  });

  // --- boot ---------------------------------------------------------------

  if (token) {
    show('wait');
    refresh().then(connect);
  } else {
    show('join');
  }
})();
