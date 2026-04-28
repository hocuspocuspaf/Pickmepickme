export function toArr(o){
  if(!o)return[];
  if(Array.isArray(o))return o;
  return Object.keys(o).sort((a,b)=>+a-+b).map(k=>o[k]);
}

export function isPermissionDenied(e){
  return e?.code==='PERMISSION_DENIED'||/permission denied/i.test(e?.message||'');
}

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
