import{ALL_RANKS,ALL_SUITS,HAND_NAMES}from'./constants.js';

export function mkDeck(){
  const d=[];
  for(const s of ALL_SUITS)for(const r of ALL_RANKS)d.push({r,s});
  return d;
}

export function shuffle(d){
  for(let i=d.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

const rv=r=>ALL_RANKS.indexOf(r);

function combos(a,k){
  if(k===0)return[[]];
  if(a.length<k)return[];
  const[h,...t]=a;
  return[...combos(t,k-1).map(c=>[h,...c]),...combos(t,k)];
}

function score5(h){
  const v=h.map(c=>rv(c.r)).sort((a,b)=>b-a),su=h.map(c=>c.s),fl=su.every(s=>s===su[0]);
  let st=false,sh=v[0];
  if(new Set(v).size===5&&v[0]-v[4]===4)st=true;
  if(!st&&v[0]===12&&v[1]===3&&v[2]===2&&v[3]===1&&v[4]===0){st=true;sh=3;}
  const fr={};v.forEach(x=>fr[x]=(fr[x]||0)+1);
  const g=Object.entries(fr).map(([r,c])=>({r:+r,c})).sort((a,b)=>b.c-a.c||b.r-a.r);
  const[g0,g1]=g;
  if(fl&&st){if(v[0]===12&&v[4]===8)return{t:9,v:[9,sh]};return{t:8,v:[8,sh]};}
  if(g0.c===4)return{t:7,v:[7,g0.r,g1?.r??0]};
  if(g0.c===3&&g1?.c===2)return{t:6,v:[6,g0.r,g1.r]};
  if(fl)return{t:5,v:[5,...v]};
  if(st)return{t:4,v:[4,sh]};
  if(g0.c===3)return{t:3,v:[3,g0.r,...g.slice(1).map(x=>x.r)]};
  if(g0.c===2&&g1?.c===2){const k=g.find(x=>x.c===1);return{t:2,v:[2,g0.r,g1.r,k?.r??0]};}
  if(g0.c===2)return{t:1,v:[1,g0.r,...g.slice(1).map(x=>x.r)]};
  return{t:0,v:[0,...v]};
}

export function cmp(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const d=(a[i]??-1)-(b[i]??-1);
    if(d)return d;
  }
  return 0;
}

export function evalHand(cards){
  let best=null,bc=null;
  for(const c of combos(cards,5)){
    const s=score5(c);
    if(!best||cmp(s.v,best.v)>0){best=s;bc=c;}
  }
  return{value:best.v,name:HAND_NAMES[best.t],bestCards:bc};
}
