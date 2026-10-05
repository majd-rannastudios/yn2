// Realistic event load: 300 guests trickling in, 10 rounds, all polling.
const BASE = process.env.BASE || 'http://localhost:3000';
const PIN = process.env.PIN || '1234';
const N = Number(process.argv[2] || 300);
const j=(p,o)=>fetch(BASE+p,o).then(async r=>({ok:r.ok,body:await r.json().catch(()=>null)}));

(async () => {
  const login = await j('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin:PIN})});
  const admin = login.body.token;
  const A=(p,b)=>j(p,{method:b?'POST':'GET',headers:{'content-type':'application/json','x-admin-token':admin},body:b?JSON.stringify(b):undefined});
  await A('/api/admin/action',{action:'reset'});
  await A('/api/admin/config',{colorCount:5,roundMinutes:10,huddleSize:6});

  const tokens=[];
  const t0=Date.now();
  for(let batch=0;batch<6;batch++){
    await Promise.all(Array.from({length:N/6},(_,i)=>{
      const n=batch*(N/6)+i;
      return j('/api/join',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({name:'Guest '+n,company:'Company '+(n%25),role:'Attendee'})}).then(r=>tokens.push(r.body.token));
    }));
  }
  console.log(`${tokens.length} guests joined in ${Date.now()-t0}ms`);

  for(let r=1;r<=10;r++){
    const t=Date.now();
    const st=await A('/api/admin/action',{action:r===1?'start':'next'});
    const rd=st.body.round;
    // every phone asks for its view at once, the way they do on rotation
    const t2=Date.now();
    const views=await Promise.all(tokens.map(tok=>j('/api/me?token='+tok).then(x=>x.body)));
    const fanout=Date.now()-t2;
    const sizes={};views.forEach(v=>{sizes[v.assignment.color.name]=(sizes[v.assignment.color.name]||0)+1;});
    const spread=Math.max(...Object.values(sizes))-Math.min(...Object.values(sizes));
    console.log(`round ${String(r).padStart(2)}: matched ${String(rd.computedMs).padStart(4)}ms | rotate+fanout ${String(Date.now()-t).padStart(4)}ms (${tokens.length} phones in ${fanout}ms) | repeats ${String(rd.stats.repeats).padStart(3)} | colleagues ${String(rd.stats.colleaguePairs).padStart(3)} | circle spread ${spread}`);
  }
  const st=await A('/api/admin/state');
  console.log(`\navg distinct people met: ${st.body.quality.avgMet.toFixed(1)} of ${N-1} possible | repeat pairs across the whole event: ${st.body.quality.repeatPairs}`);
})();
