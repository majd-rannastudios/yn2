import { assignRound, planGroups, pairKey } from '../src/assign.js';
const N=Number(process.env.GUESTS||180), COLORS=Number(process.env.COLORS||5), R=Number(process.env.ROUNDS||8);
const COMPANIES=['A','B','C','D','E','F'];

function room(){
  const p=Array.from({length:N},(_,i)=>({id:'p'+i,companyKey:i<63?COMPANIES[i%6]:'s'+i,lastColor:null,met:new Set()}));
  return [p,new Map(p.map(x=>[x.id,x])),new Map()];
}
function roster(people,r){return people.slice(0,Math.min(N,Math.floor(N*(r===0?0.7:0.7+0.08*r))));}

function run(label, huddleSize){
  const [people,byId,meetings]=room();
  let sameTwice=0, colleagueTogether=0, worstCircle=0;
  for(let r=0;r<R;r++){
    const rs=roster(people,r);
    const plan = huddleSize ? planGroups(rs.length,COLORS,huddleSize) : {groupCount:COLORS,groupColor:null,huddlesPerColor:1};
    const {groups}=assignRound(rs,plan.groupCount,meetings,{roundIndex:r,budgetMs:600,seed:11+r,groupColor:plan.groupColor});
    const circleCount=new Array(COLORS).fill(0);
    groups.forEach((g,gi)=>{
      const color=plan.groupColor?plan.groupColor[gi]:gi;
      circleCount[color]+=g.length;
      for(let i=0;i<g.length;i++){
        const a=byId.get(g[i].id);
        if(a.lastColor===color)sameTwice++;
        a.lastColor=color;
        for(let j=i+1;j<g.length;j++){
          const b=byId.get(g[j].id);
          if(a.companyKey===b.companyKey)colleagueTogether++;
          const k=pairKey(a.id,b.id);meetings.set(k,(meetings.get(k)||0)+1);
          a.met.add(b.id);b.met.add(a.id);
        }
      }
    });
    worstCircle=Math.max(worstCircle,Math.max(...circleCount)-Math.min(...circleCount));
  }
  const c=people.map(p=>p.met.size);
  const dup=[...meetings.values()].filter(v=>v>1).length;
  console.log(`${label.padEnd(30)} avg ${(c.reduce((a,b)=>a+b,0)/c.length).toFixed(1).padStart(5)} | worst ${String(Math.min(...c)).padStart(3)} | best ${String(Math.max(...c)).padStart(3)} | repeat pairs ${String(dup).padStart(4)} | colleagues ${String(colleagueTogether).padStart(3)} | same colour 2x ${sameTwice} | circle spread ${worstCircle}`);
}

console.log(`\n${N} guests, ${COLORS} colours, ${R} rounds. "avg" = distinct people each guest actually talked with.\n`);

run('whole circle talks (no huddles)', 0);
run('huddles of ~6', 6);
run('huddles of ~8', 8);
