/* Operator console. Everything the person running the room needs on one page. */

(() => {
  const $ = id => document.getElementById(id);
  let admin = sessionStorage.getItem('stw-admin');
  let data = null;
  let palette = [];

  const api = (path, opts = {}) => fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-admin-token': admin, ...(opts.headers || {}) }
  });

  // --- login --------------------------------------------------------------

  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: $('pin').value })
    });
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Wrong PIN'); return; }
    admin = (await res.json()).token;
    sessionStorage.setItem('stw-admin', admin);
    open();
  });

  async function open() {
    const res = await api('/api/admin/state');
    if (!res.ok) { sessionStorage.removeItem('stw-admin'); admin = null; return; }
    $('screen-login').classList.remove('on');
    $('screen-console').classList.add('on');
    palette = await (await fetch('/api/palette')).json();
    fillColorSelect();
    render(await res.json());
    loadQr();
    loadSignin();
    connect();
    setInterval(paintTimer, 1000);
  }

  function fillColorSelect() {
    $('cfg-colors').innerHTML = palette
      .map((_, i) => i + 1)
      .filter(n => n >= 2)
      .map(n => `<option value="${n}">${n} colours</option>`)
      .join('');
  }

  // --- actions ------------------------------------------------------------

  const act = async action => render(await (await api('/api/admin/action', {
    method: 'POST', body: JSON.stringify({ action })
  })).json());

  $('btn-primary').addEventListener('click', () => {
    const status = data?.event?.status;
    if (status === 'running') act('pause');
    else if (status === 'paused') act('resume');
    else act('start');
  });
  $('btn-next').addEventListener('click', () => act('next'));
  $('btn-more').addEventListener('click', () => act('add-time'));
  $('btn-less').addEventListener('click', () => act('less-time'));
  $('btn-end').addEventListener('click', () => {
    if (confirm('End the event for everyone? Phones will show the wrap-up screen.')) act('end');
  });
  $('btn-reset').addEventListener('click', () => {
    if (confirm('Delete every guest and every match, and start from scratch?')
      && confirm('Really? This cannot be undone.')) act('reset');
  });
  $('btn-screen').addEventListener('click', () => window.open('/screen', '_blank'));
  $('btn-export').addEventListener('click', async () => {
    const res = await api('/api/admin/export.csv');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'guests.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  $('btn-save').addEventListener('click', async () => {
    await api('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({
        // Nothing selected (an old snapshot's count with no matching option) sends nothing.
        colorCount: Number($('cfg-colors').value) || undefined,
        roundMinutes: Number($('cfg-minutes').value),
        huddleSize: Number($('cfg-huddle').value),
        showQuestions: $('cfg-questions').checked
      })
    });
    $('btn-save').textContent = 'Saved';
    setTimeout(() => { $('btn-save').textContent = 'Save setup'; }, 1400);
  });

  document.body.addEventListener('click', async e => {
    const btn = e.target.closest('.x');
    if (!btn) return;
    if (!confirm(`Remove ${btn.dataset.name} from the event?`)) return;
    await api('/api/admin/remove', { method: 'POST', body: JSON.stringify({ id: btn.dataset.id }) });
  });

  // --- render -------------------------------------------------------------

  function render(next) {
    data = next;
    const { event, store, colors, quality, round, guests } = data;

    $('status-pill').textContent = event.status;
    $('status-pill').className = `pill ${event.status}`;

    $('btn-primary').textContent =
      event.status === 'running' ? 'Pause' :
      event.status === 'paused' ? 'Resume' :
      event.status === 'ended' ? 'Restart event' : 'Start event';
    $('btn-next').disabled = event.status !== 'running' && event.status !== 'paused';

    $('kpi-guests').textContent = store.participants;
    $('kpi-active').textContent = store.active;
    $('kpi-met').textContent = quality.avgMet.toFixed(1);

    $('round-info').textContent = round
      ? `Round ${round.index} · ${round.stats.people} seated across ${round.stats.sizes.length} groups`
      : 'Not started';

    // Circles
    const max = Math.max(1, ...colors.map(c => c.count));
    $('circles').innerHTML = colors.map(c => `
      <div class="circle-row">
        <div class="swatch" style="background:${c.hex}"></div>
        <div class="nm">${c.name}</div>
        <div class="meter"><i style="width:${(c.count / max) * 100}%;background:${c.hex}"></i></div>
        <div class="count">${c.count}</div>
      </div>`).join('');

    $('circle-hint').textContent = round && round.huddlesPerColor > 1
      ? `Each circle splits into ${round.huddlesPerColor} conversation groups. Guests see who is in theirs.`
      : 'Everyone on a circle talks as one group.';

    // Health readout — the thing an operator actually needs to trust
    const health = $('health');
    if (!round) {
      health.className = 'health';
      health.textContent = store.participants
        ? `${store.participants} checked in. Press start when the room is ready.`
        : 'Waiting for guests to scan the QR.';
    } else {
      const s = round.stats;
      const spread = Math.max(...colors.map(c => c.count)) - Math.min(...colors.map(c => c.count));
      const good = s.repeats === 0 && s.colleaguePairs === 0;
      health.className = `health ${good ? 'good' : 'warn'}`;
      health.textContent = good
        ? `Clean round: nobody repeated, no colleagues paired, circles within ${spread}. Matched in ${round.computedMs}ms.`
        : `${s.repeats} repeat pairings and ${s.colleaguePairs} colleague pairings this round. ` +
          (s.repeats ? 'Shrink the conversation group size to give the matcher more room — that helps far more than adding circles.' : '');
    }

    // Setup fields — do not fight the operator while they are typing
    if (document.activeElement?.id !== 'cfg-colors') {
      $('cfg-colors').value = Math.min(event.colorCount, palette.length);
      if ($('cfg-colors').selectedIndex === -1) $('cfg-colors').selectedIndex = $('cfg-colors').options.length - 1;
    }
    if (document.activeElement?.id !== 'cfg-minutes') $('cfg-minutes').value = event.roundMinutes;
    if (document.activeElement?.id !== 'cfg-huddle') $('cfg-huddle').value = event.huddleSize;
    if (document.activeElement?.id !== 'cfg-questions') $('cfg-questions').checked = !!event.showQuestions;

    const perCircle = store.active / event.colorCount;
    $('huddle-hint').textContent = store.active
      ? `About ${perCircle.toFixed(0)} people per circle right now, so roughly ` +
        `${Math.max(1, Math.round(perCircle / event.huddleSize))} group(s) per circle.`
      : 'Smaller groups mean better conversations and fewer repeat meetings.';

    // Guests
    $('guest-count').textContent = `(${guests.length})`;
    $('guests').innerHTML = guests.map(g => {
      const c = g.color !== null && colors[g.color] ? colors[g.color] : null;
      return `<tr>
        <td><span class="dot" style="background:${g.active ? 'var(--yellow)' : 'rgba(255,255,255,0.25)'}"></span></td>
        <td>${esc(g.name)}${g.profileUrl
          ? ` <a class="tag" href="${esc(g.profileUrl)}" target="_blank" rel="noopener noreferrer">Yarnoo ↗</a>`
          : g.yarnooId ? ' <span class="tag">Yarnoo</span>' : ''}</td>
        <td class="muted">${esc(g.company)}</td>
        <td class="muted">${esc(g.role)}</td>
        <td>${c ? `<span class="dot" style="background:${c.hex}"></span> ${c.name}` : '<span class="muted">—</span>'}</td>
        <td>${g.rounds}</td>
        <td><button class="x" data-id="${g.id}" data-name="${esc(g.name)}">remove</button></td>
      </tr>`;
    }).join('');

    paintTimer();
  }

  function paintTimer() {
    if (!data) return;
    const { status, roundEndsAt, pausedRemainingMs } = data.event;
    if (status === 'paused' && pausedRemainingMs != null) {
      $('timer').textContent = fmt(pausedRemainingMs);
    } else if (roundEndsAt) {
      $('timer').textContent = fmt(Math.max(0, roundEndsAt - Date.now()));
    } else {
      $('timer').textContent = '—';
    }
  }

  const fmt = ms => {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const esc = s => String(s || '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Which doors the guest page offers - worth seeing before the room fills.
  async function loadSignin() {
    const { auth } = await (await fetch('/api/config')).json();
    $('signin-mode').textContent = {
      required: 'Guests sign in with Yarnoo - members only.',
      optional: 'Guests sign in with Yarnoo, or join as walk-ins.',
      off: 'Yarnoo sign-in is off - guests type their own name.'
    }[auth] || '';
  }

  async function loadQr() {
    const { url, dataUrl } = await (await api('/api/admin/qr')).json();
    $('qr').src = dataUrl;
    $('qr-url').textContent = url;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?role=admin&token=${admin}`);
    socket.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'admin') render(msg.data);
    };
    socket.onclose = () => setTimeout(connect, 3000);
  }

  if (admin) open();
})();
