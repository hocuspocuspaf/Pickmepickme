export function toArr(o){
  if(!o)return[];
  if(Array.isArray(o))return o;
  return Object.keys(o).sort((a,b)=>+a-+b).map(k=>o[k]);
}

export function isPermissionDenied(e){
  return e?.code==='PERMISSION_DENIED'||/permission denied/i.test(e?.message||'');
}

// Klassieke array-index rotatie (laten staan voor backward-compat)
export function nextSeat(seat,count,steps=1){
  return count?((seat+steps)%count+count)%count:0;
}

export function actionOrder(players,startSeat,limit=players.length){
  const ids=[],n=players.length;
  for(let step=0;step<Math.min(limit,n);step++){
    const p=players[nextSeat(startSeat,n,step)];
    if(p&&!p.folded&&!p.allIn)ids.push(p.id);
  }
  return ids;
}

// === NIEUW: seatIndex-gebaseerde rotatie ===

// Geeft de eerstvolgende stoel uit `seats` die strikt > currentSeat is,
// met wrap-around naar het begin. Geeft -1 als seats leeg is.
export function nextSeatIn(seats,currentSeat){
  if(!seats||!seats.length)return -1;
  const sorted=[...seats].sort((a,b)=>a-b);
  for(const s of sorted)if(s>currentSeat)return s;
  return sorted[0];
}

// Bouwt de actie-volgorde startend bij `startSeat` (inclusief),
// klokwise rond `occupiedSeats`. Filtert folded en all-in spelers eruit.
// Limit = maximaal aantal toe te voegen ids (default = alle bezette stoelen).
export function actionOrderFromSeat(players,startSeat,occupiedSeats,limit){
  const sorted=[...occupiedSeats].sort((a,b)=>a-b);
  if(!sorted.length)return[];
  const startPos=sorted.indexOf(startSeat);
  if(startPos===-1)return[];
  const max=limit==null?sorted.length:Math.min(limit,sorted.length);
  const ids=[];
  for(let i=0;i<max;i++){
    const seat=sorted[(startPos+i)%sorted.length];
    const p=players.find(x=>x.seatIndex===seat);
    if(p&&!p.folded&&!p.allIn)ids.push(p.id);
  }
  return ids;
}
