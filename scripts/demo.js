// Seed a believable room so the console and projector have live data to show.
const BASE = process.env.BASE || 'http://localhost:3000';
const PIN = process.env.PIN || '1234';
const j = (p,o) => fetch(BASE+p,o).then(async r => ({ ok:r.ok, body: await r.json().catch(()=>null) }));

const PEOPLE = [
  ['Sara Haddad','Yarnoo','Community Lead'],
  ['Omar Khalil','Yarnoo','Producer'],
  ['Lin Zhao','Meridian Bank','Head of Brand'],
  ['Karim Nasr','Meridian Bank','Marketing Lead'],
  ['Maya Fares','Northwind Group','CEO'],
  ['Youssef Aziz','Northwind Group','CFO'],
  ['Nadia Rahman','Atlas Media','Editor'],
  ['Tarek Sleiman','Atlas Media','Photographer'],
  ['Rania Osman','Vertex Labs','Product Lead'],
  ['Ali Mansour','Vertex Labs','Engineer'],
  ['Dana Chalhoub','Solstice','Partner'],
  ['Hadi Barakat','Solstice','Analyst'],
  ['Leila Hakim','Cedar Ventures','Investor'],
  ['Sami Rizk','Cedar Ventures','Associate'],
  ['Rana Ayoub','Lumen Events','Director'],
  ['Fadi Gerges','Lumen Events','Operations'],
  ['Zeina Tannous','Orbit Retail','Head of Digital'],
  ['Marc Doumit','Orbit Retail','Buyer'],
  ['Nour Chamoun','Halcyon','Founder'],
  ['Jad Maalouf','Halcyon','Designer'],
  ['Hala Sabbagh','Pinegrove','Strategist'],
  ['Ziad Kassab','Pinegrove','Consultant'],
  ['Mira Antoun','Ironwood','Head of People'],
  ['Wael Daher','Ironwood','Recruiter'],
  ['Yara Semaan','Blue Harbour','Managing Director'],
  ['Bilal Zoghbi','Blue Harbour','Advisor'],
  ['Lara Nakhle','Terrace Co','Head of Sales'],
  ['Amir Haddadin','Terrace Co','Account Lead']
];

(async () => {
  // These scripts reset the event and seat guests through the name form, so
  // they need a local server with Yarnoo sign-in off (or YARNOO_AUTH=optional).
  // Against a members-only server they would wipe the room and then fail.
  const cfg = await j('/api/config');
  if (cfg.body?.auth === 'required') {
    console.error(`${BASE} is members-only (YARNOO_AUTH=required). Run this against a local server with Yarnoo sign-in off.`);
    process.exit(1);
  }
  const login = await j('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:PIN})});
  if(!login.ok){ console.error('admin login failed'); process.exit(1); }
  const admin = login.body.token;
  const A=(p,b)=>j(p,{method:b?'POST':'GET',headers:{'content-type':'application/json','x-admin-token':admin},body:b?JSON.stringify(b):undefined});

  await A('/api/admin/action',{action:'reset'});
  await A('/api/admin/config',{ name:'Yarnoo Community Night', colorCount:5, roundMinutes:10, huddleSize:5 });

  for (const [name,company,role] of PEOPLE) {
    const r = await j('/api/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,company,role})});
    if (!r.ok) { console.error(`could not seat ${name}: ${r.body?.error || r.status}`); process.exit(1); }
  }

  // Play a few rounds so the history has substance, then land on a live one.
  for (let r=1;r<=3;r++) await A('/api/admin/action',{action: r===1?'start':'next'});

  const st = await A('/api/admin/state');
  const s = st.body;
  console.log(`seeded "${s.event.name}"`);
  console.log(`  ${s.store.participants} guests · round ${s.round.index} · ${s.round.stats.sizes.length} groups across ${s.event.colorCount} colours`);
  console.log(`  repeats ${s.round.stats.repeats} · colleagues paired ${s.round.stats.colleaguePairs} · matched in ${s.round.computedMs}ms`);
  console.log('  circles: ' + s.colors.map(c=>`${c.name} ${c.count}`).join(' · '));
  console.log(`  avg distinct met: ${s.quality.avgMet.toFixed(1)}`);
})();
