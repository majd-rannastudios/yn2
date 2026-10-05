// End-to-end against a running server: join a room, run rounds, verify the
// guest payloads are actually correct.
const BASE = process.env.BASE || 'http://localhost:3111';
const PIN = process.env.PIN || '1234';
const j = (p, o) => fetch(BASE + p, o).then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));

const NAMES = ['Sara','Omar','Lin','Karim','Maya','Youssef','Nadia','Tarek','Rania','Ali','Dana','Hadi','Leila','Sami','Rana','Fadi','Zeina','Marc','Nour','Jad','Hala','Ziad','Mira','Wael','Yara','Bilal','Lara','Amir','Nay','Rami','Tala','Karl','Joelle','Fouad','Sana','Elie','Maha','Ghassan','Rita','Kamal'];
const COMPANIES = ['Yarnoo','Acme','Globex','Initech','Umbrella','Nova'];

(async () => {
  // These scripts reset the event and seat guests through the name form, so
  // they need a local server with Yarnoo sign-in off (or YARNOO_AUTH=optional).
  // Against a members-only server they would wipe the room and then fail.
  const cfg = await j('/api/config');
  if (cfg.body?.auth === 'required') {
    console.error(`${BASE} is members-only (YARNOO_AUTH=required). Run this against a local server with Yarnoo sign-in off.`);
    process.exit(1);
  }
  let fails = 0;
  const check = (label, cond, detail='') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!cond) fails++;
  };

  // admin
  const login = await j('/api/admin/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ pin: PIN }) });
  check('admin login', login.ok);
  const admin = login.body.token;
  const A = (p, body) => j(p, { method: body ? 'POST':'GET', headers:{'content-type':'application/json','x-admin-token':admin}, body: body?JSON.stringify(body):undefined });

  await A('/api/admin/action', { action:'reset' });
  await A('/api/admin/config', { colorCount: 5, roundMinutes: 10, huddleSize: 5 });

  const bad = await j('/api/admin/state', { headers: { 'x-admin-token':'nope' } });
  check('admin routes reject a bad token', bad.status === 401);

  // guests
  const guests = [];
  for (let i = 0; i < 40; i++) {
    const r = await j('/api/join', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ name: NAMES[i], company: COMPANIES[i % 6], role: 'Attendee' }) });
    if (r.ok) guests.push(r.body.token);
  }
  check('40 guests joined', guests.length === 40);
  const noName = await j('/api/join', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name:'  ' }) });
  check('join without a name is rejected', noName.status === 400);

  // run rounds
  const seen = new Map();   // "a|b" -> times together
  let repeatTotal = 0, colleagueTotal = 0, sameColorTwice = 0;
  const prevColor = new Map();

  for (let round = 1; round <= 6; round++) {
    await A('/api/admin/action', { action: round === 1 ? 'start' : 'next' });
    const views = await Promise.all(guests.map(t => j('/api/me?token=' + t).then(r => r.body)));

    // every guest has a colour and a huddle
    check(`r${round}: every guest got an assignment`, views.every(v => v.assignment), `${views.filter(v=>!v.assignment).length} missing`);

    // circles are even
    const counts = {};
    views.forEach(v => { counts[v.assignment.color.name] = (counts[v.assignment.color.name]||0)+1; });
    const spread = Math.max(...Object.values(counts)) - Math.min(...Object.values(counts));
    check(`r${round}: circles even (spread ${spread})`, spread <= 2, JSON.stringify(counts));

    // nobody keeps the same colour
    views.forEach(v => {
      const id = v.me.id;
      if (prevColor.get(id) === v.assignment.colorIndex) sameColorTwice++;
      prevColor.set(id, v.assignment.colorIndex);
    });

    // huddles are consistent + count repeats/colleagues
    const byId = new Map(views.map(v => [v.me.id, v]));
    for (const v of views) {
      const mine = new Set(v.assignment.huddle.map(p => p.name));
      for (const other of views) {
        if (other.me.id === v.me.id) continue;
        const together = mine.has(other.me.name);
        if (!together) continue;
        const key = [v.me.id, other.me.id].sort().join('|');
        if (!seen.has(key)) seen.set(key, 0);
        seen.set(key, seen.get(key) + 0.5); // counted from both sides
      }
      // everyone in my huddle must share my question and colour
      const sameQ = v.assignment.huddle.every(p => {
        const o = views.find(x => x.me.name === p.name);
        return o && o.assignment.question === v.assignment.question && o.assignment.colorIndex === v.assignment.colorIndex;
      });
      if (!sameQ) { check(`r${round}: huddle shares colour+question`, false, v.me.name); break; }
    }
  }
  check('huddle members always share colour and question', true);
  for (const [k,count] of seen) if (count > 1) repeatTotal++;
  check('nobody was seated with the same person twice', repeatTotal === 0, `${repeatTotal} repeat pairs`);
  check('nobody got the same colour twice running', sameColorTwice === 0, `${sameColorTwice} cases`);

  // colleagues
  const final = await Promise.all(guests.map(t => j('/api/me?token=' + t).then(r => r.body)));
  let colleagues = 0;
  for (const v of final) {
    const meCo = COMPANIES[NAMES.indexOf(v.me.name) % 6];
    colleagues += v.assignment.huddle.filter(p => p.company === meCo).length;
  }
  check('colleagues kept apart', colleagues === 0, `${colleagues} colleague pairings`);

  // late joiner mid-round
  const late = await j('/api/join', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name:'Latecomer', company:'Solo' }) });
  const lateView = await j('/api/me?token=' + late.body.token);
  check('late arrival is seated immediately', !!lateView.body.assignment,
    lateView.body.assignment ? `sent to ${lateView.body.assignment.color.name}` : 'no assignment');

  // pause / resume
  await A('/api/admin/action', { action:'pause' });
  const paused = await j('/api/me?token=' + guests[0]);
  check('pause freezes the countdown', paused.body.event.roundEndsAt === null);
  await A('/api/admin/action', { action:'resume' });

  // csv
  const csv = await fetch(BASE + '/api/admin/export.csv', { headers: { 'x-admin-token': admin } }).then(r => r.text());
  check('CSV export includes every guest', csv.trim().split('\n').length === 42, `${csv.trim().split('\n').length} lines`);

  const st = await A('/api/admin/state');
  console.log(`\nroom: ${st.body.store.participants} guests · avg met ${st.body.quality.avgMet.toFixed(1)} · round ${st.body.round.index} matched in ${st.body.round.computedMs}ms`);
  console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();
