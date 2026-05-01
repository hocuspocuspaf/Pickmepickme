import{SUIT_SYMS}from'./constants.js';

export const hideOverlay=()=>document.getElementById('connecting').classList.add('hidden');

export function sdCardHtml(card){
  if(!card||!card.r||!card.s)return'';
  const red=card.s==='h'||card.s==='d';
  const s=SUIT_SYMS[card.s]||'';
  return`<div class="sd-card fu${red?' red':''}" title="${card.r}${s}">
    <span style="line-height:1">${card.r}</span>
    <span style="line-height:1">${s}</span>
  </div>`;
}

export function makeCard(rank,suit,faceUp){
  const c=document.createElement('div'),red=suit==='h'||suit==='d';
  c.className='card '+(faceUp?'face-up'+(red?' red':''):'face-down');
  if(faceUp&&rank&&suit){
    const s=SUIT_SYMS[suit];
    const wide=String(rank).length>1?' wide':'';
    c.innerHTML=`<div class="card-center"><div class="card-rank${wide}">${rank}</div><div class="card-suit">${s}</div></div>`;
  }
  return c;
}

export function spawnConfetti(){
  const p=['🃏','♠','♥','♦','♣','💰','✨'];
  for(let i=0;i<14;i++)setTimeout(()=>{
    const el=document.createElement('div');el.className='confetti';
    el.textContent=p[Math.floor(Math.random()*p.length)];
    el.style.left=Math.random()*100+'vw';el.style.top='-30px';
    el.style.animationDuration=(2+Math.random()*2)+'s';
    document.body.appendChild(el);setTimeout(()=>el.remove(),4200);
  },i*160);
}

export function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2800);
}
