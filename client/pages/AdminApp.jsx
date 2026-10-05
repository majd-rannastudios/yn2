import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo.jsx';

const fmt = ms => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const SIGNIN_LABELS = {
  required: 'Guests sign in with Yarnoo - members only.',
  optional: 'Guests sign in with Yarnoo, or join as walk-ins.',
  off: 'Yarnoo sign-in is off - guests type their own name.'
};

export default function AdminApp() {
  const [admin, setAdmin] = useState(() => sessionStorage.getItem('stw-admin'));
  const [data, setData] = useState(null);
  const [palette, setPalette] = useState([]);
  const [qr, setQr] = useState({ url: '', dataUrl: '' });
  const [signinMode, setSigninMode] = useState('');
  const [saveLabel, setSaveLabel] = useState('Save setup');
  const [now, setNow] = useState(Date.now());
  const [pin, setPin] = useState('');
  const [cfg, setCfg] = useState({ colorCount: 5, roundMinutes: 10, huddleSize: 5, showQuestions: false });
  const editingRef = useRef({});
  const adminRef = useRef(admin);
  const socketRef = useRef(null);

  useEffect(() => { adminRef.current = admin; }, [admin]);

  const api = useCallback((path, opts = {}) => fetch(path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-admin-token': adminRef.current,
      ...(opts.headers || {})
    }
  }), []);

  const connect = useCallback(() => {
    const token = adminRef.current;
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?role=admin&token=${token}`);
    socketRef.current = socket;
    socket.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'admin') setData(msg.data);
    };
    socket.onclose = () => setTimeout(connect, 3000);
  }, []);

  const openConsole = useCallback(async () => {
    const res = await api('/api/admin/state');
    if (!res.ok) {
      sessionStorage.removeItem('stw-admin');
      setAdmin(null);
      return;
    }
    const state = await res.json();
    setData(state);
    const pal = await (await fetch('/api/palette')).json();
    setPalette(pal);
    setCfg({
      colorCount: state.event.colorCount,
      roundMinutes: state.event.roundMinutes,
      huddleSize: state.event.huddleSize,
      showQuestions: !!state.event.showQuestions
    });
    const qrRes = await (await api('/api/admin/qr')).json();
    setQr(qrRes);
    const { auth } = await (await fetch('/api/config')).json();
    setSigninMode(SIGNIN_LABELS[auth] || '');
    connect();
  }, [api, connect]);

  useEffect(() => {
    if (admin) openConsole();
    return () => { try { socketRef.current?.close(); } catch { /* ignore */ } };
  }, [admin, openConsole]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Sync setup fields from server when not editing
  useEffect(() => {
    if (!data) return;
    setCfg(c => ({
      colorCount: editingRef.current.colorCount ? c.colorCount : Math.min(data.event.colorCount, palette.length || data.event.colorCount),
      roundMinutes: editingRef.current.roundMinutes ? c.roundMinutes : data.event.roundMinutes,
      huddleSize: editingRef.current.huddleSize ? c.huddleSize : data.event.huddleSize,
      showQuestions: editingRef.current.showQuestions ? c.showQuestions : !!data.event.showQuestions
    }));
  }, [data, palette.length]);

  async function onLogin(e) {
    e.preventDefault();
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    if (!res.ok) {
      alert((await res.json().catch(() => ({}))).error || 'Wrong PIN');
      return;
    }
    const token = (await res.json()).token;
    sessionStorage.setItem('stw-admin', token);
    adminRef.current = token;
    setAdmin(token);
  }

  async function act(action) {
    const res = await api('/api/admin/action', { method: 'POST', body: JSON.stringify({ action }) });
    setData(await res.json());
  }

  async function saveSetup() {
    await api('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({
        colorCount: Number(cfg.colorCount) || undefined,
        roundMinutes: Number(cfg.roundMinutes),
        huddleSize: Number(cfg.huddleSize),
        showQuestions: cfg.showQuestions
      })
    });
    editingRef.current = {};
    setSaveLabel('Saved');
    setTimeout(() => setSaveLabel('Save setup'), 1400);
  }

  async function exportCsv() {
    const res = await api('/api/admin/export.csv');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'guests.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function removeGuest(id, name) {
    if (!confirm(`Remove ${name} from the event?`)) return;
    await api('/api/admin/remove', { method: 'POST', body: JSON.stringify({ id }) });
  }

  if (!admin) {
    return (
      <div className="wrap">
        <section className="screen on" style={{ maxWidth: 400, margin: 'auto' }}>
          <div className="brand-logo"><BrandLogo /></div>
          <h1 className="hero-title">Operator<span>console</span></h1>
          <form onSubmit={onLogin}>
            <div className="field">
              <label htmlFor="pin">Event PIN</label>
              <input id="pin" type="password" autoComplete="current-password" required value={pin} onChange={e => setPin(e.target.value)} />
            </div>
            <button className="block" type="submit">Sign in</button>
          </form>
        </section>
        <footer className="site-foot">
          <a href="https://yarnoo.com" target="_blank" rel="noopener noreferrer">yarnoo.com</a>
        </footer>
      </div>
    );
  }

  if (!data) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const { event, store, colors, quality, round, guests } = data;
  const primaryLabel =
    event.status === 'running' ? 'Pause' :
    event.status === 'paused' ? 'Resume' :
    event.status === 'ended' ? 'Restart event' : 'Start event';

  let timerText = '—';
  if (event.status === 'paused' && event.pausedRemainingMs != null) timerText = fmt(event.pausedRemainingMs);
  else if (event.roundEndsAt) timerText = fmt(Math.max(0, event.roundEndsAt - now));

  const max = Math.max(1, ...colors.map(c => c.count));
  const perCircle = store.active / event.colorCount;

  let healthClass = 'health';
  let healthText = store.participants
    ? `${store.participants} checked in. Press start when the room is ready.`
    : 'Waiting for guests to scan the QR.';
  if (round) {
    const s = round.stats;
    const spread = Math.max(...colors.map(c => c.count)) - Math.min(...colors.map(c => c.count));
    const good = s.repeats === 0 && s.colleaguePairs === 0;
    healthClass = `health ${good ? 'good' : 'warn'}`;
    healthText = good
      ? `Clean round: nobody repeated, no colleagues paired, circles within ${spread}. Matched in ${round.computedMs}ms.`
      : `${s.repeats} repeat pairings and ${s.colleaguePairs} colleague pairings this round. ` +
        (s.repeats ? 'Shrink the conversation group size to give the matcher more room — that helps far more than adding circles.' : '');
  }

  const colorOptions = palette.length
    ? palette.map((_, i) => i + 1).filter(n => n >= 2)
    : [2, 3, 4, 5];

  return (
    <div className="wrap">
      <section className="screen on">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
          <div className="brand-logo"><BrandLogo /></div>
          <span className={`pill ${event.status}`}>{event.status}</span>
        </div>
        <h1 style={{ fontSize: 26, marginBottom: 18 }}>Spin The Wheel — Colors</h1>

        <div className="grid">
          <div className="card">
            <h2>Round</h2>
            <div className="big">{timerText}</div>
            <div className="muted" style={{ marginBottom: 14 }}>
              {round
                ? `Round ${round.index} · ${round.stats.people} seated across ${round.stats.sizes.length} groups`
                : 'Not started'}
            </div>
            <div className="row" style={{ marginBottom: 8 }}>
              <button type="button" onClick={() => {
                if (event.status === 'running') act('pause');
                else if (event.status === 'paused') act('resume');
                else act('start');
              }}>{primaryLabel}</button>
              <button className="ghost" type="button" disabled={event.status !== 'running' && event.status !== 'paused'} onClick={() => act('next')}>Rotate now</button>
            </div>
            <div className="row">
              <button className="ghost" type="button" onClick={() => act('less-time')}>−1 min</button>
              <button className="ghost" type="button" onClick={() => act('add-time')}>+1 min</button>
            </div>
          </div>

          <div className="card">
            <h2>The room</h2>
            <div className="kpis">
              <div><div className="big">{store.participants}</div><div className="muted" style={{ fontSize: 12 }}>checked in</div></div>
              <div><div className="big">{store.active}</div><div className="muted" style={{ fontSize: 12 }}>active now</div></div>
              <div><div className="big">{quality.avgMet.toFixed(1)}</div><div className="muted" style={{ fontSize: 12 }}>avg met each</div></div>
            </div>
            <div className={healthClass}>{healthText}</div>
          </div>

          <div className="card">
            <h2>Circles on the floor</h2>
            <div className="circles">
              {colors.map(c => (
                <div className="circle-row" key={c.name}>
                  <div className="swatch" style={{ background: c.hex }} />
                  <div className="nm">{c.name}</div>
                  <div className="meter"><i style={{ width: `${(c.count / max) * 100}%`, background: c.hex }} /></div>
                  <div className="count">{c.count}</div>
                </div>
              ))}
            </div>
            <div className="hint">
              {round && round.huddlesPerColor > 1
                ? `Each circle splits into ${round.huddlesPerColor} conversation groups. Guests see who is in theirs.`
                : 'Everyone on a circle talks as one group.'}
            </div>
          </div>

          <div className="card">
            <h2>Setup</h2>
            <div className="field">
              <label htmlFor="cfg-colors">Coloured circles on the floor</label>
              <select
                id="cfg-colors"
                value={cfg.colorCount}
                onFocus={() => { editingRef.current.colorCount = true; }}
                onBlur={() => { editingRef.current.colorCount = false; }}
                onChange={e => setCfg(c => ({ ...c, colorCount: Number(e.target.value) }))}
              >
                {colorOptions.map(n => <option key={n} value={n}>{n} colours</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cfg-minutes">Minutes per round</label>
              <input
                id="cfg-minutes"
                type="number"
                min={1}
                max={60}
                step={1}
                value={cfg.roundMinutes}
                onFocus={() => { editingRef.current.roundMinutes = true; }}
                onBlur={() => { editingRef.current.roundMinutes = false; }}
                onChange={e => setCfg(c => ({ ...c, roundMinutes: Number(e.target.value) }))}
              />
            </div>
            <div className="field">
              <label htmlFor="cfg-huddle">People per conversation group</label>
              <input
                id="cfg-huddle"
                type="number"
                min={2}
                max={20}
                step={1}
                value={cfg.huddleSize}
                onFocus={() => { editingRef.current.huddleSize = true; }}
                onBlur={() => { editingRef.current.huddleSize = false; }}
                onChange={e => setCfg(c => ({ ...c, huddleSize: Number(e.target.value) }))}
              />
              <div className="hint">
                {store.active
                  ? `About ${perCircle.toFixed(0)} people per circle right now, so roughly ${Math.max(1, Math.round(perCircle / event.huddleSize))} group(s) per circle.`
                  : 'Smaller groups mean better conversations and fewer repeat meetings.'}
              </div>
            </div>
            <label className="switch" htmlFor="cfg-questions">
              <input
                type="checkbox"
                id="cfg-questions"
                checked={cfg.showQuestions}
                onFocus={() => { editingRef.current.showQuestions = true; }}
                onBlur={() => { editingRef.current.showQuestions = false; }}
                onChange={e => setCfg(c => ({ ...c, showQuestions: e.target.checked }))}
              />
              <span>Show an icebreaker question on every phone</span>
            </label>
            <div className="hint" style={{ margin: '0 0 14px' }}>Off by default. Turn it on if the room needs a nudge — it applies from the next rotation.</div>
            <button className="block ghost" type="button" onClick={saveSetup}>{saveLabel}</button>
          </div>

          <div className="card">
            <h2>Join QR</h2>
            <img className="qr" src={qr.dataUrl} alt="QR code to join the event" />
            <div className="hint center" style={{ marginTop: 10 }}>{qr.url}</div>
            <div className="hint center">{signinMode}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="ghost" type="button" onClick={() => window.open('/screen', '_blank')}>Projector view</button>
            </div>
          </div>

          <div className="card">
            <h2>Danger zone</h2>
            <div className="row">
              <button className="ghost" type="button" onClick={exportCsv}>Export CSV</button>
              <button className="ghost" type="button" onClick={() => {
                if (confirm('End the event for everyone? Phones will show the wrap-up screen.')) act('end');
              }}>End event</button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost danger" type="button" onClick={() => {
                if (confirm('Delete every guest and every match, and start from scratch?')
                  && confirm('Really? This cannot be undone.')) act('reset');
              }}>Reset everything</button>
            </div>
            <div className="hint">Reset clears every guest and every match. Only use it between real events.</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <h2>Guests <span className="muted">({guests.length})</span></h2>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table>
              <thead>
                <tr><th /><th>Name</th><th>Company</th><th>Role</th><th>Circle</th><th>Rounds</th><th /></tr>
              </thead>
              <tbody>
                {guests.map(g => {
                  const c = g.color !== null && colors[g.color] ? colors[g.color] : null;
                  return (
                    <tr key={g.id}>
                      <td><span className="dot" style={{ background: g.active ? 'var(--yellow)' : 'rgba(255,255,255,0.25)' }} /></td>
                      <td>
                        {g.name}
                        {g.profileUrl
                          ? <> <a className="tag" href={g.profileUrl} target="_blank" rel="noopener noreferrer">Yarnoo ↗</a></>
                          : g.yarnooId ? <> <span className="tag">Yarnoo</span></> : null}
                      </td>
                      <td className="muted">{g.company}</td>
                      <td className="muted">{g.role}</td>
                      <td>{c ? <><span className="dot" style={{ background: c.hex }} /> {c.name}</> : <span className="muted">—</span>}</td>
                      <td>{g.rounds}</td>
                      <td><button className="x" type="button" onClick={() => removeGuest(g.id, g.name)}>remove</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <footer className="site-foot">
        <a href="https://yarnoo.com" target="_blank" rel="noopener noreferrer">yarnoo.com</a>
      </footer>
    </div>
  );
}
