import { useEffect, useRef, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo.jsx';
import { Sound } from '../sound.js';

export default function ScreenApp() {
  const [data, setData] = useState(null);
  const [qr, setQr] = useState('');
  const [armed, setArmed] = useState(false);
  const [moveOn, setMoveOn] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lastRoundRef = useRef(0);
  const socketRef = useRef(null);

  useEffect(() => {
    fetch('/api/screen').then(r => r.json()).then(setData);
    fetch('/api/qr').then(r => r.json()).then(({ dataUrl }) => setQr(dataUrl));

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws?role=screen`);
      socketRef.current = socket;
      socket.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'screen') setData(msg.data);
      };
      socket.onclose = () => setTimeout(connect, 3000);
    };
    connect();

    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      try { socketRef.current?.close(); } catch { /* ignore */ }
    };
  }, []);

  useEffect(() => {
    if (!data) return;
    const { event } = data;
    const live = event.status === 'running' || event.status === 'paused';
    if (event.roundIndex !== lastRoundRef.current && lastRoundRef.current !== 0 && live) {
      setMoveOn(true);
      Sound.rotate();
      const t = setTimeout(() => setMoveOn(false), 7000);
      lastRoundRef.current = event.roundIndex;
      return () => clearTimeout(t);
    }
    lastRoundRef.current = event.roundIndex;
  }, [data]);

  function arm() {
    Sound.unlock();
    Sound.tick();
    setArmed(true);
  }

  const event = data?.event;
  const colors = data?.colors || [];
  const guests = data?.guests ?? 0;
  const live = event && (event.status === 'running' || event.status === 'paused');

  let roundLabel = 'Spin The Wheel — Colors';
  let idleNote = 'Scan the code, spin for a colour, and go meet the people on that circle.';
  if (event?.status === 'ended') {
    roundLabel = 'Thank you';
    idleNote = `${guests} guests, ${event.roundIndex} rounds of new conversations.`;
  } else if (live) {
    roundLabel = `Round ${event.roundIndex}`;
  }

  let clock = '10:00';
  let clockNote = 'until the next rotation';
  let urgent = false;
  if (event?.status === 'paused') {
    clock = 'Paused';
    clockNote = 'the host will start the next round shortly';
  } else if (event?.roundEndsAt) {
    const left = Math.max(0, event.roundEndsAt - now);
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    clock = `${m}:${String(s).padStart(2, '0')}`;
    urgent = left < 60000;
    clockNote = left < 60000 ? 'get ready to move' : 'until the next rotation';
  }

  return (
    <>
      <div className="stage">
        <div className="top">
          <div className="brand-logo"><BrandLogo /></div>
          <div className="round">{roundLabel}</div>
        </div>

        {live ? (
          <div className="middle">
            <div>
              <div className={`clock${urgent ? ' urgent' : ''}`}>{clock}</div>
              <div className="clock-note">{clockNote}</div>
            </div>
            <div className="circles">
              {colors.map(c => (
                <div className="c" key={c.name}>
                  <div className="dot" style={{ background: c.hex }} />
                  <div className="nm">{c.name}</div>
                  <div className="n">{c.count}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="middle idle" style={{ display: 'grid', gridTemplateColumns: '1fr' }}>
            <div>
              <div className="idle-eyebrow">Yarnoo Community</div>
              <h1>Spin The Wheel<span>Colors</span></h1>
              <p>{idleNote}</p>
            </div>
          </div>
        )}

        <div className="bottom">
          <div className="join">
            <img className="qr" src={qr} alt="" />
            <div>Scan to join — spin for your colour and find your circle.</div>
          </div>
          <div className="right">
            <div className="count"><b>{guests}</b> guests in the room</div>
            <a className="site-link" href="https://yarnoo.com" target="_blank" rel="noopener noreferrer">yarnoo.com</a>
          </div>
        </div>
      </div>

      <div className={`move${moveOn ? ' on' : ''}`}>
        <div>
          <h1>MOVE</h1>
          <p>Check your phone for your new colour</p>
        </div>
      </div>

      {!armed && (
        <div className="arm" onClick={arm} onKeyDown={e => e.key === 'Enter' && arm()} role="button" tabIndex={0}>
          <div>
            <h2>Tap anywhere to start</h2>
            <p>Arms the rotation chime through the room speakers. Then leave this screen up for the night.</p>
          </div>
        </div>
      )}
    </>
  );
}
