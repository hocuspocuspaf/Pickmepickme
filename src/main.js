import{initFirebase,ref,set,get,update,onValue,onDisconnect}from'./firebase.js';
import{AVATAR_COLORS}from'./constants.js';
import{cmp,evalHand,mkDeck,shuffle}from'./poker.js';
import{actionOrder,actionOrderFromSeat,isPermissionDenied,nextSeat,nextSeatIn,toArr}from'./utils.js';
import{hideOverlay,makeCard,sdCardHtml,showToast,spawnConfetti}from'./ui-elements.js';

// Verberg overlay altijd na max 3 sec als fallback
setTimeout(hideOverlay,3000);

let db,auth,myId='';
try{
  ({db,auth,myId}=await initFirebase());
  hideOverlay();
  console.log('Firebase verbonden OK als',myId);
}catch(e){
  hideOverlay();
  console.error('Firebase fout:',e.message);
}

/* ═══════════════════════════════════════════════════════════
   SESSIE STATE
═══════════════════════════════════════════════════════════ */
// Persistente sessie via Firebase Auth + localStorage — overleeft page refresh
let myName  = localStorage.getItem('tvs_name')||'';
let myColor = localStorage.getItem('tvs_color')||AVATAR_COLORS[0];
let myRoomCode = localStorage.getItem('tvs_room')||'';
let isHost  = localStorage.getItem('tvs_host')==='true';
let selectedChips=10,selectedBlinds={sb:.25,bb:.50};
let selectedAvatar={create:0,join:0},currentRaiseVal=.50;
let roomRef=null,roomUnsub=null,emojiUnsub=null,cardsUnsub=null,lastSnap=null,myCardsCache=[],processingAction=false,pendingAction=false,pendingActionTimer=null,pendingActionNonce=null,selfConnectInFlight=false;
let debugPanelOpen=localStorage.getItem('tvs_debug_panel')==='true';
const PENDING_ACTION_TIMEOUT_MS=7000,HOST_WATCHDOG_MS=4000;

function saveSession(){
  localStorage.setItem('tvs_name',myName);
  localStorage.setItem('tvs_color',myColor);
  localStorage.setItem('tvs_room',myRoomCode);
  localStorage.setItem('tvs_host',isHost?'true':'false');
}
function clearSession(){
  ['tvs_id','tvs_name','tvs_color','tvs_room','tvs_host'].forEach(k=>localStorage.removeItem(k));
  myRoomCode='';myName='';isHost=false;lastSnap=null;
  myCardsCache=[];
  setPendingAction(false);
  hideResumePanel();
}

function setPendingAction(value,nonce=null){
  pendingAction=value;
  pendingActionNonce=value?nonce:null;
  if(pendingActionTimer){clearTimeout(pendingActionTimer);pendingActionTimer=null;}
  if(value){
    pendingActionTimer=setTimeout(()=>{
      pendingAction=false;
      pendingActionNonce=null;
      pendingActionTimer=null;
      if(lastSnap?.status==='playing')renderGame(lastSnap);
    },PENDING_ACTION_TIMEOUT_MS);
  }
}

function shouldClearPendingAction(room){
  if(!pendingAction)return false;
  if(room.actions?.[myId])return false;
  const nonce=room.game?.actionNonce||0;
  const toAct=toArr(room.game?.toAct||[]);
  return pendingActionNonce==null||nonce!==pendingActionNonce||toAct[0]!==myId;
}

function hideResumePanel(){document.getElementById('resume-panel')?.classList.remove('show');}
function showResumePanel(room,code){
  const p=room.players?.[myId];
  const panel=document.getElementById('resume-panel');
  if(!panel||!p)return;
  myName=p.name||localStorage.getItem('tvs_name')||'';
  myColor=p.color||localStorage.getItem('tvs_color')||myColor;
  const savedHost=room.hostId===myId;
  document.getElementById('resume-meta').textContent=`${code} · ${myName||'speler'} · ${room.status==='playing'?'spel bezig':'wachtkamer'}`;
  document.getElementById('resume-forget-btn').style.display=savedHost?'none':'block';
  document.getElementById('resume-close-btn').style.display=savedHost?'block':'none';
  ['create-name','join-name'].forEach(id=>{const el=document.getElementById(id);if(el&&!el.value)el.value=myName;});
  panel.classList.add('show');
}
function setRoomControls(room){
  const canHost=room?.hostId===myId;
  isHost=!!canHost;
  const start=document.getElementById('btn-start');
  if(start)start.style.display=(canHost&&room?.status==='waiting')?'block':'none';
  const closeWaiting=document.getElementById('btn-close-room-waiting');
  if(closeWaiting)closeWaiting.style.display=canHost?'block':'none';
  const closeGame=document.getElementById('btn-close-room-game');
  if(closeGame)closeGame.style.display=canHost?'inline-block':'none';
  const debugToggle=document.getElementById('btn-debug-toggle');
  if(debugToggle)debugToggle.style.display=canHost?'inline-flex':'none';
  if(!canHost)document.getElementById('debug-panel')?.classList.add('hidden');
}
function goHomeAfterRoomEnded(msg){
  if(roomUnsub){roomUnsub();roomUnsub=null;}
  if(emojiUnsub){emojiUnsub();emojiUnsub=null;}
  if(cardsUnsub){cardsUnsub();cardsUnsub=null;}
  renderDebugPanel(null);
  clearSession();
  window.showScreen('screen-home');
  showToast(msg);
}

async function registerDisconnect(code){
  if(!db||!code||!myId)return;
  await onDisconnect(ref(db,`rooms/${code}/players/${myId}/connected`)).set(false);
  await onDisconnect(ref(db,`rooms/${code}/players/${myId}/leftAt`)).set(Date.now());
}

async function markSelfConnected(room=null){
  if(!db||!myRoomCode||!myId||document.visibilityState==='hidden'||selfConnectInFlight)return;
  const me=room?.players?.[myId];
  if(room&&!me)return;
  if(me&&me.connected!==false)return;
  selfConnectInFlight=true;
  try{
    await update(ref(db),{
      [`rooms/${myRoomCode}/players/${myId}/connected`]:true,
      [`rooms/${myRoomCode}/players/${myId}/leftAt`]:null
    });
    if(me){
      me.connected=true;
      me.leftAt=null;
    }
  }catch(e){
    if(!isPermissionDenied(e))console.warn('Eigen verbinding herstellen mislukt:',e);
  }finally{
    selfConnectInFlight=false;
  }
}

function listenPrivateCards(){
  if(cardsUnsub){cardsUnsub();cardsUnsub=null;}
  if(!myRoomCode)return;
  cardsUnsub=onValue(ref(db,`roomSecrets/${myRoomCode}/cards/${myId}`),snap=>{
    myCardsCache=toArr(snap.val()||[]);
    if(lastSnap?.status==='playing')renderGame(lastSnap);
  });
}

async function refreshRoomFromServer(){
  if(!db||!myRoomCode)return;
  try{
    const snap=await get(ref(db,`rooms/${myRoomCode}`));
    if(!snap.exists()){goHomeAfterRoomEnded('⚠️ Tafel bestaat niet meer');return;}
    const room=snap.val();
    if(room.status==='closed'){goHomeAfterRoomEnded('🔒 Host heeft de tafel afgesloten');return;}
    await markSelfConnected(room);
    lastSnap=room;
    if(shouldClearPendingAction(room))setPendingAction(false);
    setRoomControls(room);
    if(room.status==='waiting')renderWaiting(room);
    else if(room.status==='playing'){
      if(isHost){
        await processPendingActions(room);
        await advanceStuckRoom(room);
      }
      renderGame(room);
    }
  }catch(e){
    if(!isPermissionDenied(e))console.warn('Verse tafelstatus laden mislukt:',e);
  }
}

async function advanceStuckRoom(room){
  if(!isHost||!db||!myRoomCode||processingAction)return false;
  try{
    const game=room.game||{};
    if(room.status!=='playing'||game.showdown||game._advancing||game.phase>=4)return false;
    const players=room.players||{};
    const toAct=toArr(game.toAct||[]);
    const alive=Object.values(players).filter(p=>!p.folded);
    const actionable=toAct.some(id=>{
      const p=players[id];
      return p&&!p.folded&&!p.allIn;
    });
    const shouldAdvance=alive.length<=1||toAct.length===0||!actionable;
    if(!shouldAdvance)return false;
    await update(ref(db,`rooms/${myRoomCode}/game`),{_advancing:true});
    try{
      if(alive.length<=1)await endRound(players,game.pot||0,game);
      else if(bettingSettledByAllIn(players,game.currentBet||0))await runShowdown(room);
      else await nextPhase(room);
    }finally{
      await update(ref(db,`rooms/${myRoomCode}/game`),{_advancing:false});
    }
    return true;
  }catch(e){
    console.error('Tafel vooruitzetten mislukt:',e);
    if(isPermissionDenied(e))showToast('⚠️ Firebase Rules moeten bijgewerkt worden');
    return false;
  }
}

setInterval(()=>{
  if(!myRoomCode||document.visibilityState==='hidden')return;
  if(roomUnsub&&(isHost||pendingAction))refreshRoomFromServer();
},HOST_WATCHDOG_MS);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&roomUnsub)refreshRoomFromServer();
});
window.addEventListener('focus',()=>{if(roomUnsub)refreshRoomFromServer();});

/* ═══════════════════════════════════════════════════════════
   LOBBY UI — expose to window (onclick attr werkt in modules)
═══════════════════════════════════════════════════════════ */
function buildAvatarGrids(){
  ['create-avatar','join-avatar'].forEach((id,gi)=>{
    const grid=document.getElementById(id),type=gi===0?'create':'join';
    AVATAR_COLORS.forEach((col,i)=>{
      const d=document.createElement('div');
      d.className='avatar-option'+(i===0?' selected':'');
      d.style.background=col;
      d.onclick=()=>{selectedAvatar[type]=i;grid.querySelectorAll('.avatar-option').forEach((el,j)=>el.classList.toggle('selected',j===i));};
      grid.appendChild(d);
    });
  });
}
buildAvatarGrids();

// Toon een keuze na refresh in plaats van meteen opnieuw te verbinden
(async()=>{
  const savedRoom=localStorage.getItem('tvs_room');
  if(!savedRoom||!db)return;
  try{
    const snap=await get(ref(db,`rooms/${savedRoom}`));
    if(!snap.exists()){
      clearSession();
      showToast('⚠️ Vorige kamer bestaat niet meer');
      return;
    }
    const room=snap.val();
    if(room.status==='closed'){
      clearSession();
      showToast('🔒 Vorige tafel is afgesloten');
      return;
    }
    const playerStillIn=room.players&&room.players[myId];
    if(!playerStillIn){
      clearSession();
      showToast('⚠️ Je bent niet meer in de kamer');
      return;
    }
    showResumePanel(room,savedRoom);
  }catch(e){
    if(!isPermissionDenied(e))console.warn('Sessiekeuze laden mislukt:',e);
    clearSession();
  }
})();

window.switchTab=tab=>{
  document.querySelectorAll('.lobby-tab').forEach((t,i)=>t.classList.toggle('active',(i===0)===(tab==='create')));
  document.getElementById('tab-create').classList.toggle('active',tab==='create');
  document.getElementById('tab-join').classList.toggle('active',tab==='join');
};
window.selectChips=el=>{document.querySelectorAll('#chips-presets .chips-preset').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');selectedChips=parseFloat(el.dataset.val);};
window.selectBlinds=el=>{document.querySelectorAll('#blind-presets .chips-preset').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');selectedBlinds={sb:parseFloat(el.dataset.sb),bb:parseFloat(el.dataset.bb)};};
window.showScreen=id=>{document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');};
window.copyCode=()=>{navigator.clipboard?.writeText(myRoomCode);showToast('📋 Code gekopieerd!');};

window.resumeRoom=async()=>{
  const code=localStorage.getItem('tvs_room');
  if(!code||!db){clearSession();return;}
  const snap=await get(ref(db,`rooms/${code}`));
  if(!snap.exists()){clearSession();showToast('⚠️ Tafel bestaat niet meer');return;}
  const room=snap.val();
  if(room.status==='closed'){clearSession();showToast('🔒 Tafel is afgesloten');return;}
  const p=room.players?.[myId];
  if(!p){clearSession();showToast('⚠️ Je plek bestaat niet meer');return;}
  myRoomCode=code;
  myName=p.name||localStorage.getItem('tvs_name')||myName;
  myColor=p.color||localStorage.getItem('tvs_color')||myColor;
  selectedChips=room.settings?.chips||10;
  selectedBlinds={sb:room.settings?.sb||.25,bb:room.settings?.bb||.50};
  setRoomControls(room);
  saveSession();
  await registerDisconnect(code);
  await update(ref(db),{
    [`rooms/${code}/players/${myId}/connected`]:true,
    [`rooms/${code}/players/${myId}/leftAt`]:null,
    [`rooms/${code}/players/${myId}/name`]:myName,
    [`rooms/${code}/players/${myId}/color`]:myColor
  });
  hideResumePanel();
  document.getElementById('display-code').textContent=code;
  listenRoom();
  if(room.status==='waiting')window.showScreen('screen-waiting');
  showToast('🔄 Terug aan tafel');
};

window.forgetSavedRoom=async()=>{
  const code=localStorage.getItem('tvs_room');
  try{
    if(db&&code)await update(ref(db,`rooms/${code}/players/${myId}`),{connected:false,leftAt:Date.now()});
  }catch(e){console.warn('Tafel loslaten mislukt:',e);}
  clearSession();
  window.showScreen('screen-home');
  showToast('Nieuwe tafel kan gestart worden');
};

/* ═══════════════════════════════════════════════════════════
   KAMER AANMAKEN
═══════════════════════════════════════════════════════════ */
window.createRoom=async()=>{
  const name=document.getElementById('create-name').value.trim();
  if(!name){showToast('⚠️ Voer je naam in');return;}
  hideResumePanel();
  myName=name;myColor=AVATAR_COLORS[selectedAvatar.create];isHost=true;
  myRoomCode='TAFEL-'+Math.floor(1000+Math.random()*9000);
  await set(ref(db,`rooms/${myRoomCode}`),{hostId:myId,status:'waiting',settings:{chips:selectedChips,sb:selectedBlinds.sb,bb:selectedBlinds.bb},created:Date.now()});
  await registerDisconnect(myRoomCode);
  // Host krijgt altijd stoel 0 — dat blijft ook tussen rondes ongewijzigd.
  await set(ref(db,`rooms/${myRoomCode}/players/${myId}`),{name:myName,color:myColor,chips:selectedChips,bet:0,totalBet:0,folded:false,allIn:false,lastAction:'',seatIndex:0,connected:true,joinedAt:Date.now()});
  saveSession();
  document.getElementById('display-code').textContent=myRoomCode;
  setRoomControls({hostId:myId,status:'waiting'});
  listenRoom();
  window.showScreen('screen-waiting');
};

/* ═══════════════════════════════════════════════════════════
   KAMER JOINEN
═══════════════════════════════════════════════════════════ */
window.joinRoom=async()=>{
  const name=document.getElementById('join-name').value.trim();
  const code=document.getElementById('join-code').value.trim().toUpperCase();
  if(!name){showToast('⚠️ Voer je naam in');return;}
  if(code.length<4){showToast('⚠️ Voer de kamercode in');return;}
  let snap;
  try{
    snap=await get(ref(db,`rooms/${code}`));
  }catch(e){
    console.warn('Kamer laden mislukt:',e);
    showToast('❌ Tafel is al bezig of niet beschikbaar');
    return;
  }
  if(!snap.exists()){showToast('❌ Kamer niet gevonden');return;}
  const room=snap.val();
  if(room.status==='closed'){showToast('🔒 Deze tafel is afgesloten');return;}
  const existing=room.players?.[myId];
  if(room.status==='playing'&&!existing){showToast('❌ Spel is al bezig');return;}
  const count=Object.keys(room.players||{}).length;
  if(count>=10&&!existing){showToast('❌ Kamer vol (max 10)');return;}
  myName=name;myColor=AVATAR_COLORS[selectedAvatar.join];isHost=room.hostId===myId;myRoomCode=code;
  selectedChips=room.settings.chips;selectedBlinds={sb:room.settings.sb,bb:room.settings.bb};
  await registerDisconnect(code);
  if(existing){
    await update(ref(db),{
      [`rooms/${code}/players/${myId}/name`]:myName,
      [`rooms/${code}/players/${myId}/color`]:myColor,
      [`rooms/${code}/players/${myId}/connected`]:true,
      [`rooms/${code}/players/${myId}/leftAt`]:null
    });
  }else{
    // Zoek de eerste vrije stoel (0..9). Stoelen blijven eenmaal toegekend
    // vast hangen aan de speler — ook als ze later disconnecten of bust gaan.
    const usedSeats=new Set(Object.values(room.players||{}).map(p=>p.seatIndex));
    let freeSeat=0;
    while(usedSeats.has(freeSeat)&&freeSeat<10)freeSeat++;
    if(freeSeat>=10){showToast('❌ Kamer vol (max 10)');return;}
    await set(ref(db,`rooms/${code}/players/${myId}`),{name:myName,color:myColor,chips:selectedChips,bet:0,totalBet:0,folded:false,allIn:false,lastAction:'',seatIndex:freeSeat,connected:true,joinedAt:Date.now()});
  }
  saveSession();
  document.getElementById('display-code').textContent=code;
  setRoomControls(room);
  listenRoom();
  showToast('✅ Verbonden!');
  if(room.status==='waiting')window.showScreen('screen-waiting');
};

/* ═══════════════════════════════════════════════════════════
   ROOM LISTENER
═══════════════════════════════════════════════════════════ */
function listenRoom(){
  if(roomUnsub){roomUnsub();roomUnsub=null;}
  roomRef=ref(db,`rooms/${myRoomCode}`);
  roomUnsub=onValue(roomRef,snap=>{
    if(!snap.exists()){goHomeAfterRoomEnded('⚠️ Tafel bestaat niet meer');return;}
    const room=snap.val();
    if(room.status==='closed'){goHomeAfterRoomEnded('🔒 Host heeft de tafel afgesloten');return;}
    markSelfConnected(room);
    lastSnap=room;
    setRoomControls(room);
    if(room.status==='waiting'){renderWaiting(room);}
    else if(room.status==='playing'){
      if(!document.getElementById('screen-game').classList.contains('active')){
        document.getElementById('game-room-code').textContent='♠ '+myRoomCode;
        window.showScreen('screen-game');
        listenPrivateCards();
        listenEmoji();
      }
      if(isHost)processPendingActions(room);
      renderGame(room);
    }
  });
}

function renderWaiting(room){
  const pl=Object.entries(room.players||{}).map(([id,p])=>({id,...p})).sort((a,b)=>a.seatIndex-b.seatIndex);
  document.getElementById('player-count').textContent=pl.filter(p=>p.connected!==false).length;
  const ul=document.getElementById('waiting-players');
  ul.innerHTML='';
  pl.forEach(p=>{
    const row=document.createElement('div');row.className='player-row';
    if(p.connected===false)row.style.opacity='.55';
    const badge=p.id===room.hostId?'<span class="pbadge badge-host">Host</span>':(p.connected===false?'<span class="pbadge badge-offline">Offline</span>':'<span class="pbadge badge-ready">Klaar</span>');
    row.innerHTML=`<div class="player-avatar-sm" style="background:${p.color}">${(p.name||'?')[0]}</div>
      <span class="name">${p.name}</span>
      ${badge}`;
    ul.appendChild(row);
  });
}

/* ═══════════════════════════════════════════════════════════
   SPEL STARTEN (host)
═══════════════════════════════════════════════════════════ */
window.startGame=async()=>{
  if(!isHost){showToast('Alleen de host kan starten');return;}
  const snap=await get(ref(db,`rooms/${myRoomCode}`));
  const room=snap.val();
  await markSelfConnected(room);
  const all=Object.entries(room.players||{}).map(([id,p])=>({id,...p})).sort((a,b)=>a.seatIndex-b.seatIndex);
  const pl=all.filter(p=>p.connected!==false&&p.chips>0);
  const parked=all.filter(p=>p.connected===false||p.chips<=0);
  if(pl.length<2){showToast('⚠️ Minimaal 2 spelers nodig');return;}
  // Eerste dealer = laagste actieve seatIndex (= host op stoel 0).
  const firstDealer=Math.min(...pl.map(p=>p.seatIndex));
  await dealNewRound(pl,room.settings,firstDealer,1,parked);
  await update(ref(db,`rooms/${myRoomCode}`),{status:'playing'});
};

async function dealNewRound(pl,settings,dealerSeatIdx,roundNum,parked=[]){
  const sb=settings.sb,bb=settings.bb;
  const deck=shuffle(mkDeck());
  const pUpdates={},privateCards={};
  let startingPot=0,currentBet=0;

  // Werken met echte seatIndex'en (0–9). De seatIndex blijft tussen rondes
  // ongewijzigd — spelers blijven aan dezelfde stoel zitten.
  const activeSeats=pl.map(p=>p.seatIndex).sort((a,b)=>a-b);
  let sbSeatIdx,bbSeatIdx;
  if(activeSeats.length===2){
    // Heads-up regel: dealer = SB, andere speler = BB.
    sbSeatIdx=dealerSeatIdx;
    bbSeatIdx=nextSeatIn(activeSeats,dealerSeatIdx);
  }else{
    sbSeatIdx=nextSeatIn(activeSeats,dealerSeatIdx);
    bbSeatIdx=nextSeatIn(activeSeats,sbSeatIdx);
  }

  pl.forEach(p=>{
    const c1=deck.pop(),c2=deck.pop();
    let bet=0,chips=p.chips;
    if(p.seatIndex===sbSeatIdx){bet=Math.min(sb,chips);chips-=bet;}
    if(p.seatIndex===bbSeatIdx){bet=Math.min(bb,chips);chips-=bet;}
    startingPot+=bet;
    currentBet=Math.max(currentBet,bet);
    privateCards[p.id]={0:c1,1:c2};
    pUpdates[p.id]={name:p.name,color:p.color,chips,bet,totalBet:bet,folded:false,allIn:chips===0,lastAction:'',seatIndex:p.seatIndex,connected:p.connected!==false,joinedAt:p.joinedAt||Date.now()};
  });
  parked.forEach(p=>{
    pUpdates[p.id]={name:p.name,color:p.color,chips:p.chips||0,bet:0,totalBet:p.totalBet||0,folded:true,allIn:true,lastAction:'Offline',seatIndex:p.seatIndex,connected:false,joinedAt:p.joinedAt||Date.now(),leftAt:p.leftAt||Date.now()};
  });

  const handPlayers=pl.map(p=>({id:p.id,...pUpdates[p.id]}));
  // Pre-flop: actie begint na de BB (= UTG). In heads-up valt dat samen
  // met de SB (= dealer), wat ook klopt voor heads-up regels.
  const firstToAct=nextSeatIn(activeSeats,bbSeatIdx);
  const toAct=actionOrderFromSeat(handPlayers,firstToAct,activeSeats);

  await update(ref(db),{
    [`rooms/${myRoomCode}/players`]:pUpdates,
    [`rooms/${myRoomCode}/actions`]:null,
    [`rooms/${myRoomCode}/game`]:{phase:0,pot:Math.round(startingPot*100)/100,currentBet,dealerSeat:dealerSeatIdx,sbSeat:sbSeatIdx,bbSeat:bbSeatIdx,toAct,community:[],roundNum,showdown:false,winnerIds:[],showCards:{},actionNonce:0},
    [`roomSecrets/${myRoomCode}/deck`]:deck,
    [`roomSecrets/${myRoomCode}/cards`]:privateCards
  });
}

/* ═══════════════════════════════════════════════════════════
   GAME RENDERER
═══════════════════════════════════════════════════════════ */
const PHASES=['Pre-Flop','Flop','Turn','River','Showdown'];
let showdownShown=false;

function actionButtonsHtml(){
  return `<button class="action-btn btn-fold"  id="btn-fold"  onclick="doAction('fold')"  disabled>FOLD  <sub>Kaarten neerleggen</sub></button>
      <button class="action-btn btn-check" id="btn-check" onclick="doAction('check')" disabled>CHECK <sub>Niets inzetten</sub></button>
      <button class="action-btn btn-raise" id="btn-raise" onclick="openRaise()"       disabled>RAISE <sub>Meer inzetten</sub></button>
      <button class="action-btn btn-allin" id="btn-allin" onclick="doAction('allin')" disabled>ALL-IN<sub>Alles op het spel</sub></button>`;
}

function minRaiseTo(game,settings=selectedBlinds){
  const currentBet=game?.currentBet||0;
  const bb=settings?.bb||selectedBlinds.bb||0.5;
  const target=currentBet>0?Math.max(currentBet*2,currentBet+bb):bb;
  return Math.round(target*100)/100;
}

function cents(v){
  return Math.round((Number(v)||0)*100);
}

function fromCents(v){
  return Math.round(v)/100;
}

function bettingSettledByAllIn(players,currentBet){
  const alive=Object.values(players||{}).filter(p=>!p.folded);
  if(alive.length<=1)return false;
  const canStillBet=alive.filter(p=>!p.allIn);
  if(canStillBet.length>1)return false;
  return alive.every(p=>p.allIn||cents(p.bet)>=cents(currentBet));
}

function splitCents(payouts,winners,amount){
  if(!winners.length||amount<=0)return;
  const ordered=[...winners].sort((a,b)=>(a.p.seatIndex??0)-(b.p.seatIndex??0));
  const share=Math.floor(amount/ordered.length);
  let rest=amount%ordered.length;
  ordered.forEach(w=>{
    payouts[w.id]=(payouts[w.id]||0)+share+(rest>0?1:0);
    if(rest>0)rest--;
  });
}

function showdownPayouts(players,cands){
  const evals=new Map(cands.map(c=>[c.id,c]));
  const entries=Object.entries(players||{})
    .map(([id,p])=>({id,p,bet:cents(p.totalBet)}))
    .filter(x=>x.bet>0);
  const levels=[...new Set(entries.map(x=>x.bet))].sort((a,b)=>a-b);
  const payouts={};
  let prev=0;
  levels.forEach(level=>{
    const contributors=entries.filter(x=>x.bet>=level);
    const amount=(level-prev)*contributors.length;
    prev=level;
    const eligible=contributors.filter(x=>!x.p.folded&&evals.has(x.id)).map(x=>evals.get(x.id));
    if(!eligible.length)return;
    let best=null;
    eligible.forEach(c=>{if(!best||cmp(c.ev.value,best)>0)best=c.ev.value;});
    splitCents(payouts,eligible.filter(c=>cmp(c.ev.value,best)===0),amount);
  });
  return payouts;
}

function visualSeatPos(index,total){
  if(total<=1||index===0)return{x:50,y:88};
  const others=total-1;
  const angle=others===1?270:180+((index-1)*180)/(others-1);
  const rad=angle*Math.PI/180;
  return{
    x:Math.round((50+43*Math.cos(rad))*100)/100,
    y:Math.round((50+38*Math.sin(rad))*100)/100
  };
}

function esc(v){
  return String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function shortId(id){
  return id?String(id).slice(0,6):'-';
}

function debugSeatLabel(seat,players){
  const p=players.find(x=>x.seatIndex===seat);
  return seat==null||seat<0?'-':`${seat}${p?` ${p.name||shortId(p.id)}`:''}`;
}

function debugPlayerLine(p,toAct,room){
  const active=toAct[0]===p.id;
  const action=room.actions?.[p.id]?.type||'';
  const flags=[
    p.connected===false?'<span class="debug-pill warn">offline</span>':'<span class="debug-pill on">online</span>',
    p.folded?'<span class="debug-pill warn">fold</span>':'',
    p.allIn?'<span class="debug-pill warn">all-in</span>':'',
    active?'<span class="debug-pill on">turn</span>':'',
    action?`<span class="debug-pill warn">${esc(action)}</span>`:''
  ].join('');
  return `<div class="debug-line">
    <span class="debug-name">#${p.seatIndex} ${esc(p.name||shortId(p.id))} ${p.id===myId?'(jij)':''}</span>
    <span>€${(p.chips||0).toFixed(2)} / bet €${(p.bet||0).toFixed(2)} ${flags}</span>
  </div>`;
}

function renderDebugPanel(room,players=null,toAct=null){
  const panel=document.getElementById('debug-panel');
  if(!panel)return;
  if(!room||!isHost){panel.classList.add('hidden');return;}
  const game=room.game||{};
  const allP=players||Object.entries(room.players||{}).map(([id,p])=>({id,...p})).sort((a,b)=>a.seatIndex-b.seatIndex);
  const turn=toAct||toArr(game.toAct||[]);
  const actions=Object.entries(room.actions||{}).map(([id,a])=>`${shortId(id)}:${a?.type||'?'}${a?.amount!=null?` ${Number(a.amount).toFixed(2)}`:''}`).join(', ')||'-';
  const turnNames=turn.map(id=>allP.find(p=>p.id===id)?.name||shortId(id)).join(' > ')||'-';
  panel.classList.toggle('hidden',!debugPanelOpen);
  panel.innerHTML=`<div class="debug-title">
      <span>DEBUG ${esc(myRoomCode)}</span>
      <button class="debug-toggle" onclick="toggleDebugPanel()">Verberg</button>
    </div>
    <div class="debug-grid">
      <div class="debug-cell"><span class="debug-label">Phase</span><span class="debug-value">${esc(PHASES[game.phase]||game.phase||0)}</span></div>
      <div class="debug-cell"><span class="debug-label">Nonce</span><span class="debug-value">${game.actionNonce??0}</span></div>
      <div class="debug-cell"><span class="debug-label">Pot</span><span class="debug-value">€${(game.pot||0).toFixed(2)}</span></div>
      <div class="debug-cell"><span class="debug-label">Bet</span><span class="debug-value">€${(game.currentBet||0).toFixed(2)}</span></div>
      <div class="debug-cell"><span class="debug-label">Dealer</span><span class="debug-value">${esc(debugSeatLabel(game.dealerSeat,allP))}</span></div>
      <div class="debug-cell"><span class="debug-label">SB</span><span class="debug-value">${esc(debugSeatLabel(game.sbSeat,allP))}</span></div>
      <div class="debug-cell"><span class="debug-label">BB</span><span class="debug-value">${esc(debugSeatLabel(game.bbSeat,allP))}</span></div>
      <div class="debug-cell"><span class="debug-label">Adv</span><span class="debug-value">${game._advancing?'yes':'no'}</span></div>
    </div>
    <div class="debug-section"><span class="debug-label">toAct</span><div class="debug-value">${esc(turnNames)}</div></div>
    <div class="debug-section"><span class="debug-label">Actions</span><div class="debug-value">${esc(actions)}</div></div>
    <div class="debug-section">${allP.map(p=>debugPlayerLine(p,turn,room)).join('')}</div>
    <div class="debug-section"><span class="debug-label">Client</span>
      <div class="debug-value">pending=${pendingAction?'yes':'no'} processing=${processingAction?'yes':'no'} selfConnect=${selfConnectInFlight?'yes':'no'}</div>
    </div>`;
}

window.toggleDebugPanel=()=>{
  debugPanelOpen=!debugPanelOpen;
  localStorage.setItem('tvs_debug_panel',debugPanelOpen?'true':'false');
  renderDebugPanel(lastSnap);
};

function renderGame(room){
  const game=room.game||{},pl=room.players||{};
  const allP=Object.entries(pl).map(([id,p])=>({id,...p})).sort((a,b)=>a.seatIndex-b.seatIndex);
  const myIdx=allP.findIndex(p=>p.id===myId);
  const mySeatIdx=allP[myIdx]?.seatIndex??0;
  const toAct=toArr(game.toAct||[]);
  const community=toArr(game.community||[]);
  const winnerIds=toArr(game.winnerIds||[]);
  const isShowdown=!!game.showdown;
  const showCards=game.showCards||{};

  // Community cards
  const cc=document.getElementById('community-cards');cc.innerHTML='';
  for(let i=0;i<5;i++)cc.appendChild(community[i]?makeCard(community[i].r,community[i].s,true):makeCard(null,null,false));

  // Pot of showdown-banner in tafelcentrum
  if(isShowdown&&winnerIds.length>0){
    const winP=allP.find(p=>p.id===winnerIds[0]);
    const wCards=toArr(showCards[winnerIds[0]]||(winnerIds[0]===myId?myCardsCache:(winP?.cards||[])));
    let handLabel='';
    if(community.length>=3&&wCards.length>=2){try{handLabel=evalHand([...wCards,...community]).name;}catch(e){}}
    const potEl=document.getElementById('pot-display');
    potEl.innerHTML=`<span style="color:var(--gold);font-size:.78rem">🏆 ${winP?.name||'?'} wint!</span>${handLabel?`<br><span style="font-size:.65rem;color:var(--text-dim)">${handLabel}</span>`:''}`;
    potEl.style.borderColor='rgba(201,168,76,0.6)';
  } else {
    document.getElementById('pot-display').textContent=`POT: €${(game.pot||0).toFixed(2)}`;
    document.getElementById('pot-display').style.borderColor='rgba(201,168,76,0.28)';
  }
  document.getElementById('game-phase').textContent=PHASES[game.phase]||'Pre-Flop';

  // Seats — order blijft op echte seatIndex, maar de visuele afstand schaalt mee met aantal spelers.
  const con=document.getElementById('seats-container');con.innerHTML='';
  const visualPlayers=[...allP].sort((a,b)=>((a.seatIndex-mySeatIdx+10)%10)-((b.seatIndex-mySeatIdx+10)%10));
  const visualIndexById=new Map(visualPlayers.map((p,i)=>[p.id,i]));
  allP.forEach(p=>{
    const pos=visualSeatPos(visualIndexById.get(p.id)??0,visualPlayers.length);
    const isActive=toAct[0]===p.id;
    const isWinner=winnerIds.includes(p.id);
    let badge='';
    if(p.seatIndex===game.dealerSeat)badge='<div class="seat-badge badge-D">D</div>';
    else if(p.seatIndex===game.sbSeat)badge='<div class="seat-badge badge-SB">SB</div>';
    else if(p.seatIndex===game.bbSeat)badge='<div class="seat-badge badge-BB">BB</div>';
    const aMap={Fold:'fold',Check:'check',Call:'call',Raise:'raise','All-In':'all-in'};
    const actHtml=(!isShowdown&&p.lastAction)?`<div class="seat-action action-${aMap[p.lastAction]||'check'}">${p.lastAction}</div>`:'';
    // Kaarten: bij showdown face-up tonen voor niet-gefoldde spelers
    let cardsHtml='';
    if(!p.folded){
      const pCards=toArr(showCards[p.id]||(p.id===myId?(myCardsCache.length?myCardsCache:(p.cards||[])):(p.cards||[])));
      if(isShowdown&&pCards.length>=2){
        cardsHtml='<div class="seat-showdown-cards">'+sdCardHtml(pCards[0])+sdCardHtml(pCards[1])+'</div>';
      } else {
        cardsHtml='<div class="seat-cards"><div class="seat-card-sm"></div><div class="seat-card-sm"></div></div>';
      }
    }
    const winBadge=isWinner?'<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);font-size:0.7rem;background:var(--gold);color:#1a1000;border-radius:8px;padding:1px 6px;font-weight:700;white-space:nowrap">🏆 WINNAAR</div>':'';
    const s=document.createElement('div');
    s.id=`seat-${p.id}`;
    s.className='seat'+(p.folded?' folded':'')+(isActive?' active-turn':'')+(isWinner?' winner-seat':'');
    s.style.left=pos.x+'%';s.style.top=pos.y+'%';
    s.innerHTML=`<div class="seat-inner">${badge}${winBadge}
      <div class="seat-avatar" style="background:${p.color}">${(p.name||'?')[0]}</div>
      <div class="seat-name">${p.name}${p.id===myId?' 👤':''}</div>
      <div class="seat-chips">€${(p.chips||0).toFixed(2)}</div>
      ${cardsHtml}${actHtml}</div>
      ${p.bet>0?`<div class="seat-bet">€${(p.bet||0).toFixed(2)}</div>`:''}`;
    con.appendChild(s);
  });

  // Mijn kaarten + info
  const me=pl[myId]||{};
  const ownCards=myCardsCache.length?myCardsCache:toArr(me.cards||[]);
  if(shouldClearPendingAction(room))setPendingAction(false);
  const mc=document.getElementById('my-cards');mc.innerHTML='';
  ownCards.forEach(c=>mc.appendChild(makeCard(c.r,c.s,true)));
  document.getElementById('my-name').textContent=me.name||myName;
  document.getElementById('my-chips').textContent=`€${(me.chips||0).toFixed(2)}`;

  // Actie knoppen
  const myActionPending=pendingAction||!!room.actions?.[myId];
  const myTurn=toAct[0]===myId&&!me.folded&&!me.allIn&&!game.showdown&&!myActionPending;
  const toCall=Math.max(0,(game.currentBet||0)-(me.bet||0));
  document.getElementById('turn-badge').style.display=(myTurn&&!isShowdown)?'block':'none';
  // Toon "Toon Winnaar" knop voor host als spel vastloopt
  const stuck=isHost&&toAct.length===0&&(game.phase||0)<4&&!game.showdown;
  const fbtn=document.getElementById('btn-force');
  if(fbtn)fbtn.style.display=stuck?'inline-block':'none';
  renderDebugPanel(room,allP,toAct);

  // Action panel tijdens showdown: vervang knoppen door volgende ronde UI
  const abPanel=document.querySelector('.action-buttons');
  if(isShowdown){
    abPanel.innerHTML=isHost
      ?`<div class="showdown-next" style="width:100%;gap:12px">
          <button class="btn-next-inline" onclick="nextRound()">Volgende Ronde →</button>
          <button onclick="leaveRoom()" style="background:transparent;border:1px solid var(--border);color:var(--text-dim);border-radius:8px;padding:.6rem 1rem;font-family:Rajdhani,sans-serif;font-weight:700;font-size:.85rem;cursor:pointer;letter-spacing:.05em">Stoppen</button>
        </div>`
      :`<div class="showdown-next" style="width:100%">
          <span class="waiting-next">⏳ Wachten op host voor volgende ronde…</span>
        </div>`;
  } else {
    if(abPanel.querySelector('.showdown-next')){
      // Nieuwe ronde gestart – herstel knoppen
      abPanel.innerHTML=actionButtonsHtml();
    }
    ['btn-fold','btn-check','btn-raise','btn-allin'].forEach(id=>{
      const btn=document.getElementById(id);
      if(btn)btn.disabled=!myTurn;
    });
    const cb=document.getElementById('btn-check');
    if(cb){
      if(toCall<=0){cb.innerHTML='CHECK <sub>Niets inzetten</sub>';cb.className='action-btn btn-check';cb.onclick=()=>doAction('check');}
      else{cb.innerHTML=`CALL €${toCall.toFixed(2)} <sub>Meebieden</sub>`;cb.className='action-btn btn-call';cb.onclick=()=>doAction('call');}
    }
  }

  // Showdown: confetti 1x afspelen, daarna via renderSeats zichtbaar
  if(game.showdown&&!showdownShown){showdownShown=true;showShowdown(allP,community,game);}
  if(!game.showdown){
    showdownShown=false;
    // Nieuwe ronde gestart — zorg dat overlay (legacy) gesloten is
    const ov=document.getElementById('winner-overlay');
    if(ov&&ov.classList.contains('show'))ov.classList.remove('show');
  }

  // Auto-advance: host bewaakt de ronde, spelers dienen alleen acties in
  const aliveNow=allP.filter(p=>!p.folded);
  if(isHost && aliveNow.length<=1 && game.phase<4 && !game.showdown && !game._advancing){
    setTimeout(async()=>{
      const snap2=await get(ref(db,`rooms/${myRoomCode}`));
      if(!snap2.exists())return;
      await advanceStuckRoom(snap2.val());
    },700);
  }else if(isHost && toAct.length===0 && game.phase<4 && !game.showdown && !game._advancing){
    setTimeout(async()=>{
      const snap2=await get(ref(db,`rooms/${myRoomCode}`));
      if(!snap2.exists())return;
      await advanceStuckRoom(snap2.val());
    },1200);
  }
}

/* ═══════════════════════════════════════════════════════════
   ACTIES
═══════════════════════════════════════════════════════════ */
async function submitAction(type,amount=null){
  if(!lastSnap||pendingAction||lastSnap.actions?.[myId])return;
  const toAct=toArr(lastSnap.game?.toAct||[]);
  if(toAct[0]!==myId)return;
  const nonce=lastSnap.game?.actionNonce||0;
  setPendingAction(true,nonce);
  try{
    await set(ref(db,`rooms/${myRoomCode}/actions/${myId}`),{type,amount,ts:Date.now(),nonce});
  }catch(e){
    setPendingAction(false);
    throw e;
  }
  const lbl={fold:'🃏 Gefold',check:'✋ Check',call:'📞 Call',allin:'💥 ALL-IN!',raise:'💰 Raise aangevraagd'};
  showToast(lbl[type]||type);
}

window.doAction=async action=>{
  await submitAction(action);
};

window.confirmRaise=async()=>{
  if(!lastSnap)return;
  const game=lastSnap.game;
  const toAct=toArr(game.toAct||[]);
  if(toAct[0]!==myId)return;
  closeRaise();
  await submitAction('raise',currentRaiseVal);
};

async function processPendingActions(room){
  if(processingAction||room.status!=='playing'||room.game?.showdown)return;
  const toAct=toArr(room.game?.toAct||[]);
  const currentId=toAct[0];
  if(!currentId)return;
  const action=room.actions?.[currentId]||(room.players?.[currentId]?.connected===false?{type:'fold',auto:true}:null);
  if(!action)return;
  if(!action.auto&&action.nonce!==(room.game?.actionNonce||0)){
    processingAction=true;
    try{await set(ref(db,`rooms/${myRoomCode}/actions/${currentId}`),null);}
    finally{processingAction=false;}
    return;
  }
  processingAction=true;
  try{
    await applyPlayerAction(currentId,action,room);
  }catch(e){
    console.error('Actie verwerken mislukt:',e);
    showToast('⚠️ Actie kon niet verwerkt worden');
  }finally{
    processingAction=false;
  }
}

async function applyPlayerAction(playerId,actionReq,room){
  const game=room.game||{},players=room.players||{},me=players[playerId];
  if(!me)return;
  const toAct=toArr(game.toAct||[]);
  if(toAct[0]!==playerId)return;
  const action=actionReq.type;
  const toCall=Math.max(0,(game.currentBet||0)-(me.bet||0));
  const minRaiseTarget=minRaiseTo(game,room.settings);
  let nm={...me},pot=game.pot||0,curBet=game.currentBet||0,needReopen=false;
  delete nm.cards;
  let newToAct=toAct.slice(1);

  if(action==='fold'){nm.folded=true;nm.lastAction='Fold';}
  else if(action==='check'){
    if(toCall>0){await set(ref(db,`rooms/${myRoomCode}/actions/${playerId}`),null);return;}
    nm.lastAction='Check';
  }
  else if(action==='call'){
    if(toCall<=0){nm.lastAction='Check';}
    else{const a=Math.min(toCall,nm.chips);nm.chips-=a;nm.bet+=a;nm.totalBet+=a;pot+=a;nm.lastAction=nm.chips===0?'All-In':'Call';if(nm.chips===0)nm.allIn=true;}
  }else if(action==='allin'){
    const a=nm.chips;nm.chips=0;nm.bet+=a;nm.totalBet+=a;pot+=a;
    if(nm.bet>curBet){
      curBet=nm.bet;
      needReopen=nm.bet>=minRaiseTarget;
    }
    nm.allIn=true;nm.lastAction='All-In';
  }else if(action==='raise'){
    const targetBet=Math.max(0,Math.round((parseFloat(actionReq.amount)||0)*100)/100);
    if(targetBet<minRaiseTarget){await set(ref(db,`rooms/${myRoomCode}/actions/${playerId}`),null);return;}
    const add=Math.min(Math.max(0,targetBet-nm.bet),nm.chips);
    nm.chips-=add;nm.bet+=add;nm.totalBet+=add;pot+=add;
    if(nm.bet>curBet){curBet=nm.bet;needReopen=true;}
    nm.lastAction=nm.chips===0?'All-In':'Raise';if(nm.chips===0)nm.allIn=true;
  }else{
    await set(ref(db,`rooms/${myRoomCode}/actions/${playerId}`),null);
    return;
  }

  if(needReopen){
    // Bij een raise heropent het bieden — alle andere niet-gefoldde,
    // niet all-in spelers moeten opnieuw kunnen reageren. We werken nu
    // op echte seatIndex'en, dus stoelen kunnen sparse zijn (gaten).
    const allPArr=Object.entries(players).map(([id,p])=>({id,...p,folded:id===playerId?nm.folded:p.folded,allIn:id===playerId?nm.allIn:p.allIn}));
    const liveSeats=allPArr.filter(x=>!x.folded).map(x=>x.seatIndex).sort((a,b)=>a-b);
    const restartSeat=nextSeatIn(liveSeats,me.seatIndex);
    newToAct=actionOrderFromSeat(allPArr,restartSeat,liveSeats,liveSeats.length-1);
  }

  const updatedPlayers={...players,[playerId]:nm};
  await update(ref(db),{
    [`rooms/${myRoomCode}/players/${playerId}`]:nm,
    [`rooms/${myRoomCode}/game/pot`]:Math.round(pot*100)/100,
    [`rooms/${myRoomCode}/game/currentBet`]:Math.round(curBet*100)/100,
    [`rooms/${myRoomCode}/game/toAct`]:newToAct,
    [`rooms/${myRoomCode}/game/actionNonce`]:(game.actionNonce||0)+1,
    [`rooms/${myRoomCode}/actions/${playerId}`]:null
  });

  const alive=Object.values(updatedPlayers).filter(p=>!p.folded);
  if(alive.length<=1)await endRound(updatedPlayers,pot,game);
  else if(bettingSettledByAllIn(updatedPlayers,curBet)){
    await runShowdown({...room,players:updatedPlayers,game:{...game,pot,currentBet:curBet,toAct:[]}});
  }
  else if(newToAct.length===0)await nextPhase({...room,players:updatedPlayers,game:{...game,pot,currentBet:curBet,toAct:newToAct}});
}

/* ═══════════════════════════════════════════════════════════
   FASE OVERGANG
═══════════════════════════════════════════════════════════ */
async function nextPhase(room){
  const game=room.game,players=room.players;
  if(bettingSettledByAllIn(players,game.currentBet||0)){await runShowdown(room);return;}
  const nextPh=(game.phase||0)+1;
  if(nextPh>=4){await runShowdown(room);return;}
  const deckSnap=await get(ref(db,`roomSecrets/${myRoomCode}/deck`));
  const deck=toArr(deckSnap.val()||game.deck||[]),comm=toArr(game.community||[]);
  if(nextPh===1){comm.push(deck.pop(),deck.pop(),deck.pop());}else{comm.push(deck.pop());}
  const allP=Object.entries(players).map(([id,p])=>({id,...p})).sort((a,b)=>a.seatIndex-b.seatIndex);
  // Postflop: actie begint bij eerste niet-gefoldde stoel ná de dealer.
  // In heads-up valt dat samen met de BB, wat klopt voor heads-up regels.
  const liveSeats=allP.filter(p=>!p.folded).map(p=>p.seatIndex).sort((a,b)=>a-b);
  const ds=game.dealerSeat??0;
  const firstToAct=nextSeatIn(liveSeats,ds);
  const newToAct=actionOrderFromSeat(allP,firstToAct,liveSeats);
  const reset={};allP.forEach(p=>{const{cards,...clean}=players[p.id];reset[p.id]={...clean,bet:0,lastAction:''};});
  await update(ref(db,`rooms/${myRoomCode}`),{
    players:reset,
    actions:null,
    'game/phase':nextPh,'game/pot':game.pot,'game/currentBet':0,
    'game/community':comm,'game/toAct':newToAct,
    'game/showdown':false,'game/showCards':{},'game/_advancing':false
  });
  await set(ref(db,`roomSecrets/${myRoomCode}/deck`),deck);

  // Als na fase-overgang niemand meer hoeft te acteren → meteen verder
  if(newToAct.length===0&&isHost){
    setTimeout(async()=>{
      const snap3=await get(ref(db,`rooms/${myRoomCode}`));
      if(!snap3.exists())return;
      await advanceStuckRoom(snap3.val());
    },900);
  }
}

async function endRound(players,pot,game){
  const winner=Object.values(players).find(p=>!p.folded);
  if(!winner)return;
  const wId=Object.entries(players).find(([,p])=>!p.folded)?.[0];
  if(!wId)return;
  const cardsSnap=await get(ref(db,`roomSecrets/${myRoomCode}/cards/${wId}`));
  const winnerCards=cardsSnap.val()||players[wId].cards||{};
  const{cards,...winnerClean}=players[wId];
  const updated={...winnerClean,chips:Math.round((players[wId].chips+pot)*100)/100};
  await update(ref(db),{
    [`rooms/${myRoomCode}/players/${wId}`]:updated,
    [`rooms/${myRoomCode}/actions`]:null,
    [`rooms/${myRoomCode}/game/pot`]:0,
    [`rooms/${myRoomCode}/game/phase`]:4,
    [`rooms/${myRoomCode}/game/showdown`]:true,
    [`rooms/${myRoomCode}/game/winnerIds`]:[wId],
    [`rooms/${myRoomCode}/game/showCards/${wId}`]:winnerCards
  });
}

/* ═══════════════════════════════════════════════════════════
   SHOWDOWN
═══════════════════════════════════════════════════════════ */
async function runShowdown(room){
  const game=room.game,players=room.players;
  const comm=toArr(game.community||[]);
  let deck=null;
  if(comm.length<5){
    const deckSnap=await get(ref(db,`roomSecrets/${myRoomCode}/deck`));
    deck=toArr(deckSnap.val()||game.deck||[]);
    while(comm.length<5&&deck.length)comm.push(deck.pop());
    await set(ref(db,`roomSecrets/${myRoomCode}/deck`),deck);
  }
  const cardsSnap=await get(ref(db,`roomSecrets/${myRoomCode}/cards`));
  const privateCards=cardsSnap.val()||{};
  const showCards={};
  const cands=Object.entries(players).filter(([,p])=>!p.folded).map(([id,p])=>{
    const cardsObj=privateCards[id]||p.cards||{};
    const cards=toArr(cardsObj);
    showCards[id]=cardsObj;
    return{id,p,ev:evalHand([...cards,...comm])};
  });
  const payouts=showdownPayouts(players,cands);
  const pUp={};
  Object.entries(players).forEach(([id,p])=>{const{cards,...clean}=p;pUp[id]={...clean};});
  Object.entries(payouts).forEach(([id,amount])=>{
    if(pUp[id])pUp[id].chips=Math.round((pUp[id].chips+fromCents(amount))*100)/100;
  });
  await update(ref(db,`rooms/${myRoomCode}`),{
    players:pUp,
    actions:null,
    'game/pot':0,'game/phase':4,'game/showdown':true,
    'game/toAct':[],
    'game/community':comm,
    'game/winnerIds':Object.entries(payouts).filter(([,amount])=>amount>0).map(([id])=>id),
    'game/showCards':showCards
  });
}

function showShowdown(allP,community,game){
  // Geen overlay — kaarten worden op tafel getoond via renderSeats
  // Enkel confetti spawnen
  spawnConfetti();
}

window.forceShowdown=async()=>{
  if(!isHost)return;
  try{
    const snap=await get(ref(db,`rooms/${myRoomCode}`));
    if(!snap.exists())return;
    const room=snap.val();
    const alive=Object.values(room.players||{}).filter(p=>!p.folded);
    if(alive.length<=1){await endRound(room.players,room.game?.pot||0,room.game||{});}
    else await runShowdown(room);
  }catch(e){
    console.error('Showdown forceren mislukt:',e);
    if(isPermissionDenied(e))showToast('⚠️ Firebase Rules moeten bijgewerkt worden');
    else showToast('⚠️ Toon winnaar lukt niet');
  }
};
window.nextRound=async()=>{
  if(!isHost){showToast('Alleen de host start de volgende ronde');return;}
  showdownShown=false;
  const snap=await get(ref(db,`rooms/${myRoomCode}`));
  const room=snap.val();
  await markSelfConnected(room);
  const allP=Object.entries(room.players||{}).map(([id,p])=>({id,...p}));
  const active=allP.filter(p=>p.connected!==false&&p.chips>0);
  const parked=allP.filter(p=>p.connected===false||p.chips<=0);
  if(active.length<2){showToast('Te weinig spelers met chips!');return;}
  // De dealer schuift exact 1 plek door naar de eerstvolgende actieve stoel.
  // (We sturen niet langer een "extra" nextSeat door — dat veroorzaakte de +2 bug.)
  const oldDealer=room.game?.dealerSeat??-1;
  const activeSeats=active.map(p=>p.seatIndex).sort((a,b)=>a-b);
  const newDealer=nextSeatIn(activeSeats,oldDealer);
  await dealNewRound(active,room.settings,newDealer,(room.game?.roundNum||1)+1,parked);
  showToast(`🔄 Ronde ${(room.game?.roundNum||1)+1} gestart!`);
};

/* ═══════════════════════════════════════════════════════════
   EMOJI (realtime voor alle spelers)
═══════════════════════════════════════════════════════════ */
window.sendEmoji=async emoji=>{
  await set(ref(db,`rooms/${myRoomCode}/emoji`),{playerId:myId,emoji,ts:Date.now()});
};
function listenEmoji(){
  if(emojiUnsub)emojiUnsub();
  emojiUnsub=onValue(ref(db,`rooms/${myRoomCode}/emoji`),snap=>{
    if(!snap.exists())return;
    const{playerId,emoji,ts}=snap.val();
    if(Date.now()-ts>5000)return; // te oud negeren
    const seat=document.getElementById(`seat-${playerId}`)?.querySelector('.seat-inner');
    if(!seat)return;
    const fl=document.createElement('div');fl.className='emoji-float';fl.textContent=emoji;
    seat.appendChild(fl);setTimeout(()=>fl.remove(),2300);
  });
}

/* ═══════════════════════════════════════════════════════════
   VERLATEN
═══════════════════════════════════════════════════════════ */
async function markCurrentPlayerAway(){
  if(!db||!myRoomCode)return;
  const snap=await get(ref(db,`rooms/${myRoomCode}`));
  if(!snap.exists())return;
  const room=snap.val();
  if(room.status==='closed')return;
  const me=room.players?.[myId];
  if(!me)return;
  const updates={
    [`rooms/${myRoomCode}/players/${myId}/connected`]:false,
    [`rooms/${myRoomCode}/players/${myId}/leftAt`]:Date.now()
  };
  if(room.status==='playing'&&room.game&&!room.game.showdown&&!me.folded){
    updates[`rooms/${myRoomCode}/actions/${myId}`]={type:'fold',ts:Date.now(),auto:true};
  }
  await update(ref(db),updates);
}

window.leaveRoom=async()=>{
  try{await markCurrentPlayerAway();}catch(e){console.warn('Verlaten mislukt:',e);}
  if(roomUnsub){roomUnsub();roomUnsub=null;}
  if(emojiUnsub){emojiUnsub();emojiUnsub=null;}
  if(cardsUnsub){cardsUnsub();cardsUnsub=null;}
  renderDebugPanel(null);
  setPendingAction(false);
  window.showScreen('screen-home');
  showToast('Je bent tijdelijk van tafel');
  const code=localStorage.getItem('tvs_room');
  if(code&&lastSnap)showResumePanel(lastSnap,code);
};

window.closeRoom=async()=>{
  const code=myRoomCode||localStorage.getItem('tvs_room');
  if(!code||!db){clearSession();window.showScreen('screen-home');return;}
  const snap=await get(ref(db,`rooms/${code}`));
  if(!snap.exists()){clearSession();window.showScreen('screen-home');return;}
  const room=snap.val();
  if(room.hostId!==myId){showToast('Alleen de host kan afsluiten');return;}
  await update(ref(db),{
    [`rooms/${code}/status`]:'closed',
    [`rooms/${code}/closedAt`]:Date.now(),
    [`rooms/${code}/closedBy`]:myId,
    [`roomSecrets/${code}`]:null
  });
  if(roomUnsub){roomUnsub();roomUnsub=null;}
  if(emojiUnsub){emojiUnsub();emojiUnsub=null;}
  if(cardsUnsub){cardsUnsub();cardsUnsub=null;}
  renderDebugPanel(null);
  clearSession();
  window.showScreen('screen-home');
  showToast('🔒 Tafel afgesloten');
};

/* ═══════════════════════════════════════════════════════════
   RAISE POPUP
═══════════════════════════════════════════════════════════ */
window.openRaise=()=>{
  if(!lastSnap)return;
  const me=lastSnap.players?.[myId]||{},game=lastSnap.game||{};
  const min=minRaiseTo(game,lastSnap.settings);
  const max=(me.bet||0)+(me.chips||0);
  if(max<min){doAction('allin');return;}
  const sl=document.getElementById('raise-slider');
  sl.min=min.toFixed(2);sl.max=max.toFixed(2);sl.step=(selectedBlinds.bb/2).toFixed(2);
  updateRaise(Math.min(min,max));
  document.getElementById('raise-popup').classList.add('open');
};
window.closeRaise=()=>document.getElementById('raise-popup').classList.remove('open');
window.updateRaise=val=>{
  currentRaiseVal=Math.round(parseFloat(val)*100)/100;
  document.getElementById('raise-display').textContent='NAAR €'+currentRaiseVal.toFixed(2);
  document.getElementById('raise-slider').value=val;
};
window.setRaisePct=pct=>{
  const pot=lastSnap?.game?.pot||0,me=lastSnap?.players?.[myId]||{},game=lastSnap?.game||{};
  const currentBet=game.currentBet||0;
  const min=minRaiseTo(game,lastSnap?.settings);
  const max=(me.bet||0)+(me.chips||0);
  updateRaise(Math.min(max,Math.max(min,currentBet+Math.round(pot*pct*100)/100)));
};

window.showToast=showToast;
