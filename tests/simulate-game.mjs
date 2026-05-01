import assert from 'node:assert/strict';
import {actionOrderFromSeat,nextSeatIn} from '../src/utils.js';

const settings={sb:0.25,bb:0.5};

function makePlayer(id,seatIndex,chips=10,connected=true){
  return {id,name:id,seatIndex,chips,bet:0,totalBet:0,folded:false,allIn:false,lastAction:'',connected,joinedAt:1};
}

function bySeat(a,b){
  return a.seatIndex-b.seatIndex;
}

function asPlayersMap(players){
  return Object.fromEntries(players.map(p=>[p.id,{...p}]));
}

function minRaiseTo(game){
  const currentBet=game?.currentBet||0;
  const bb=settings.bb;
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

function showdownPayoutsByRank(players,ranks){
  const cands=Object.entries(ranks).map(([id,rank])=>({id,p:players[id],rank}));
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
    const best=Math.max(...eligible.map(c=>c.rank));
    splitCents(payouts,eligible.filter(c=>c.rank===best),amount);
  });
  return Object.fromEntries(Object.entries(payouts).map(([id,amount])=>[id,fromCents(amount)]));
}

function expectSeq(actual,expected,label){
  assert.deepEqual(actual,expected,label);
}

function dealRound(players,dealerSeatIdx,roundNum=1){
  const sorted=[...players].sort(bySeat);
  const active=sorted.filter(p=>p.connected!==false&&p.chips>0);
  const parked=sorted.filter(p=>p.connected===false||p.chips<=0);
  const activeSeats=active.map(p=>p.seatIndex).sort((a,b)=>a-b);
  let sbSeatIdx,bbSeatIdx;

  if(activeSeats.length===2){
    sbSeatIdx=dealerSeatIdx;
    bbSeatIdx=nextSeatIn(activeSeats,dealerSeatIdx);
  }else{
    sbSeatIdx=nextSeatIn(activeSeats,dealerSeatIdx);
    bbSeatIdx=nextSeatIn(activeSeats,sbSeatIdx);
  }

  let pot=0,currentBet=0;
  const handPlayers=active.map(p=>{
    let bet=0,chips=p.chips;
    if(p.seatIndex===sbSeatIdx){bet=Math.min(settings.sb,chips);chips-=bet;}
    if(p.seatIndex===bbSeatIdx){bet=Math.min(settings.bb,chips);chips-=bet;}
    pot+=bet;
    currentBet=Math.max(currentBet,bet);
    return {...p,chips,bet,totalBet:bet,folded:false,allIn:chips===0,lastAction:''};
  });

  const parkedPlayers=parked.map(p=>({
    ...p,bet:0,folded:true,allIn:true,lastAction:'Offline',connected:false
  }));

  const firstToAct=nextSeatIn(activeSeats,bbSeatIdx);
  const toAct=actionOrderFromSeat(handPlayers,firstToAct,activeSeats);

  return {
    status:'playing',
    settings,
    players:asPlayersMap([...handPlayers,...parkedPlayers]),
    actions:null,
    game:{
      phase:0,
      pot:Math.round(pot*100)/100,
      currentBet,
      dealerSeat:dealerSeatIdx,
      sbSeat:sbSeatIdx,
      bbSeat:bbSeatIdx,
      toAct,
      community:[],
      roundNum,
      showdown:false,
      winnerIds:[],
      showCards:{},
      actionNonce:0
    }
  };
}

function nextDealer(room){
  const active=Object.values(room.players).filter(p=>p.connected!==false&&p.chips>0);
  const activeSeats=active.map(p=>p.seatIndex).sort((a,b)=>a-b);
  return nextSeatIn(activeSeats,room.game?.dealerSeat??-1);
}

function postflopOrder(room){
  const players=Object.entries(room.players).map(([id,p])=>({id,...p})).sort(bySeat);
  const liveSeats=players.filter(p=>!p.folded).map(p=>p.seatIndex).sort((a,b)=>a-b);
  const firstToAct=nextSeatIn(liveSeats,room.game.dealerSeat);
  return actionOrderFromSeat(players,firstToAct,liveSeats);
}

function applyAction(room,playerId,actionReq){
  const players=room.players;
  const game=room.game;
  const me=players[playerId];
  assert.equal(game.toAct[0],playerId,`${playerId} is not first to act`);

  const action=actionReq.type;
  const toCall=Math.max(0,(game.currentBet||0)-(me.bet||0));
  const minRaiseTarget=minRaiseTo(game);
  let nm={...me},pot=game.pot||0,curBet=game.currentBet||0,needReopen=false;
  let newToAct=game.toAct.slice(1);

  if(action==='fold'){
    nm.folded=true;
    nm.lastAction='Fold';
  }else if(action==='check'){
    assert.equal(toCall,0,'check is only valid when nothing is owed');
    nm.lastAction='Check';
  }else if(action==='call'){
    if(toCall<=0){
      nm.lastAction='Check';
    }else{
      const amount=Math.min(toCall,nm.chips);
      nm.chips-=amount;
      nm.bet+=amount;
      nm.totalBet+=amount;
      pot+=amount;
      nm.lastAction=nm.chips===0?'All-In':'Call';
      if(nm.chips===0)nm.allIn=true;
    }
  }else if(action==='allin'){
    const amount=nm.chips;
    nm.chips=0;
    nm.bet+=amount;
    nm.totalBet+=amount;
    pot+=amount;
    if(nm.bet>curBet){
      curBet=nm.bet;
      needReopen=nm.bet>=minRaiseTarget;
    }
    nm.allIn=true;
    nm.lastAction='All-In';
  }else if(action==='raise'){
    const targetBet=Math.max(0,Math.round((parseFloat(actionReq.amount)||0)*100)/100);
    assert.ok(targetBet>=minRaiseTarget,`raise target ${targetBet} must be at least ${minRaiseTarget}`);
    const add=Math.min(Math.max(0,targetBet-nm.bet),nm.chips);
    nm.chips-=add;
    nm.bet+=add;
    nm.totalBet+=add;
    pot+=add;

    if(nm.bet>curBet){curBet=nm.bet;needReopen=true;}
    nm.lastAction=nm.chips===0?'All-In':'Raise';
    if(nm.chips===0)nm.allIn=true;
  }else{
    throw new Error(`Unknown action ${action}`);
  }

  if(needReopen){
    const allPArr=Object.entries(players).map(([id,p])=>({
      id,
      ...p,
      folded:id===playerId?nm.folded:p.folded,
      allIn:id===playerId?nm.allIn:p.allIn
    }));
    const liveSeats=allPArr.filter(p=>!p.folded).map(p=>p.seatIndex).sort((a,b)=>a-b);
    const restartSeat=nextSeatIn(liveSeats,me.seatIndex);
    newToAct=actionOrderFromSeat(allPArr,restartSeat,liveSeats,liveSeats.length-1);
  }

  return {
    ...room,
    players:{...players,[playerId]:nm},
    game:{
      ...game,
      pot:Math.round(pot*100)/100,
      currentBet:Math.round(curBet*100)/100,
      toAct:newToAct,
      actionNonce:(game.actionNonce||0)+1
    }
  };
}

function assertNoInvalidToAct(room,label){
  const seen=new Set();
  for(const id of room.game.toAct){
    assert.ok(!seen.has(id),`${label}: duplicate toAct id ${id}`);
    seen.add(id);
    const p=room.players[id];
    assert.ok(p,`${label}: missing player ${id}`);
    assert.equal(p.folded,false,`${label}: folded player in toAct ${id}`);
    assert.equal(p.allIn,false,`${label}: all-in player in toAct ${id}`);
  }
}

function runAllInClosureAndSidePotScenario(){
  let room=dealRound([
    makePlayer('allin',0,10),
    makePlayer('folder',1,10),
    makePlayer('caller',2,15)
  ],0);
  room={
    ...room,
    game:{...room.game,phase:1,currentBet:0,pot:0,toAct:['allin','folder','caller']},
    players:Object.fromEntries(Object.entries(room.players).map(([id,p])=>[
      id,
      {...p,chips:id==='caller'?15:10,bet:0,totalBet:0,folded:false,allIn:false,lastAction:''}
    ]))
  };

  room=applyAction(room,'allin',{type:'allin'});
  assert.equal(room.players.allin.bet,10,'postflop all-in puts full stack in');
  assert.equal(bettingSettledByAllIn(room.players,room.game.currentBet),false,'caller still has to decide');
  room=applyAction(room,'folder',{type:'fold'});
  assert.equal(bettingSettledByAllIn(room.players,room.game.currentBet),false,'remaining caller still owes the all-in call');
  room=applyAction(room,'caller',{type:'call'});
  assert.equal(room.players.caller.chips,5,'caller can have chips left after matching all-in');
  assert.equal(bettingSettledByAllIn(room.players,room.game.currentBet),true,'after the call no further betting is possible');

  const sidePlayers={
    allin:{...makePlayer('allin',0,0),bet:10,totalBet:10,allIn:true},
    folder:{...makePlayer('folder',1,8),bet:0,totalBet:2,folded:true},
    caller:{...makePlayer('caller',2,4.8),bet:10.2,totalBet:10.2}
  };
  const shortStackWins=showdownPayoutsByRank(sidePlayers,{allin:10,caller:5});
  assert.deepEqual(shortStackWins,{allin:22,caller:0.2},'short all-in winner gets main pot, unmatched side bet returns to caller');

  const bigStackWins=showdownPayoutsByRank(sidePlayers,{allin:5,caller:10});
  assert.deepEqual(bigStackWins,{caller:22.2},'caller with best hand can win main pot plus own side pot');
}

function runFixedScenarios(){
  let players=[makePlayer('host',0),makePlayer('left',1),makePlayer('right',2)];
  let dealer=0;
  const expected=[
    {dealer:0,sb:1,bb:2,toAct:['host','left','right']},
    {dealer:1,sb:2,bb:0,toAct:['left','right','host']},
    {dealer:2,sb:0,bb:1,toAct:['right','host','left']},
    {dealer:0,sb:1,bb:2,toAct:['host','left','right']}
  ];
  expected.forEach((exp,i)=>{
    const room=dealRound(players,dealer,i+1);
    assert.equal(room.game.dealerSeat,exp.dealer,`round ${i+1}: dealer`);
    assert.equal(room.game.sbSeat,exp.sb,`round ${i+1}: small blind`);
    assert.equal(room.game.bbSeat,exp.bb,`round ${i+1}: big blind`);
    expectSeq(room.game.toAct,exp.toAct,`round ${i+1}: preflop order`);
    assertNoInvalidToAct(room,`round ${i+1}`);
    players=Object.entries(room.players).map(([id,p])=>({id,...p}));
    dealer=nextDealer(room);
  });

  const sparse=dealRound([
    makePlayer('host',0),
    makePlayer('seat3',3),
    makePlayer('seat7',7)
  ],0);
  assert.equal(sparse.game.sbSeat,3,'sparse seats: sb');
  assert.equal(sparse.game.bbSeat,7,'sparse seats: bb');
  expectSeq(sparse.game.toAct,['host','seat3','seat7'],'sparse seats: preflop order wraps correctly');
  expectSeq(postflopOrder(sparse),['seat3','seat7','host'],'sparse seats: postflop starts left of dealer');

  const headsUp=dealRound([makePlayer('host',0),makePlayer('villain',3)],0);
  assert.equal(headsUp.game.sbSeat,0,'heads-up: dealer is small blind');
  assert.equal(headsUp.game.bbSeat,3,'heads-up: other player is big blind');
  expectSeq(headsUp.game.toAct,['host','villain'],'heads-up: dealer acts first preflop');
  expectSeq(postflopOrder(headsUp),['villain','host'],'heads-up: big blind acts first postflop');

  const withOffline=dealRound([
    makePlayer('host',0),
    makePlayer('offline',1,10,false),
    makePlayer('active',2)
  ],0);
  expectSeq(withOffline.game.toAct,['host','active'],'offline player is parked outside toAct');
  assert.equal(withOffline.players.offline.folded,true,'offline player is folded');

  let raiseRoom=dealRound([makePlayer('host',0),makePlayer('left',1),makePlayer('right',2)],0);
  raiseRoom=applyAction(raiseRoom,'host',{type:'raise',amount:1.5});
  assert.equal(raiseRoom.players.host.bet,1.5,'raise amount is the target total bet');
  expectSeq(raiseRoom.game.toAct,['left','right'],'raise by first actor reopens only later players');
  raiseRoom=applyAction(raiseRoom,'left',{type:'call'});
  expectSeq(raiseRoom.game.toAct,['right'],'caller is removed from toAct');

  let middleRaise=dealRound([makePlayer('host',0),makePlayer('left',1),makePlayer('right',2)],0);
  middleRaise=applyAction(middleRaise,'host',{type:'call'});
  middleRaise=applyAction(middleRaise,'left',{type:'raise',amount:1.5});
  expectSeq(middleRaise.game.toAct,['right','host'],'middle raise asks players after raiser, then wraps to host');

  let invalidRaise=dealRound([makePlayer('host',0),makePlayer('left',1),makePlayer('right',2)],0);
  assert.throws(
    ()=>applyAction(invalidRaise,'host',{type:'raise',amount:0.75}),
    /at least 1/,
    'preflop raise below double big blind is rejected'
  );

  let allInRoom=dealRound([makePlayer('host',0),makePlayer('left',1,0.25),makePlayer('right',2)],0);
  assert.equal(allInRoom.players.left.allIn,true,'short small blind is all-in');
  expectSeq(allInRoom.game.toAct,['host','right'],'all-in player is skipped in toAct');
}

function runUserExampleScenario(){
  const players=[
    makePlayer('Mark',0),
    makePlayer('Simon',1),
    makePlayer('Tommy',2),
    makePlayer('Lisa',3)
  ];
  let room=dealRound(players,0);

  assert.equal(room.game.pot,0.75,'example: blinds create 0.75 pot');
  assert.equal(room.game.dealerSeat,0,'example: Mark is dealer');
  assert.equal(room.game.sbSeat,1,'example: Simon is small blind');
  assert.equal(room.game.bbSeat,2,'example: Tommy is big blind');
  expectSeq(room.game.toAct,['Lisa','Mark','Simon','Tommy'],'example: Lisa UTG acts first preflop');

  const normalPostflopRoom={
    ...room,
    players:{
      ...room.players,
      Lisa:{...room.players.Lisa,folded:true}
    }
  };
  expectSeq(postflopOrder(normalPostflopRoom),['Simon','Tommy','Mark'],'example: postflop starts left of dealer and skips folded Lisa');

  room=applyAction(room,'Lisa',{type:'fold'});
  expectSeq(room.game.toAct,['Mark','Simon','Tommy'],'example: folded UTG is removed');

  room=applyAction(room,'Mark',{type:'raise',amount:1.5});
  assert.equal(room.players.Mark.bet,1.5,'example: Mark raises to total 1.50');
  assert.equal(room.players.Mark.chips,8.5,'example: Mark has 8.50 behind after raise');
  expectSeq(room.game.toAct,['Simon','Tommy'],'example: Simon and Tommy respond to Mark raise');

  room=applyAction(room,'Simon',{type:'call'});
  assert.equal(room.players.Simon.bet,1.5,'example: Simon has total 1.50 after adding 1.25');
  assert.equal(room.players.Simon.chips,8.5,'example: Simon has 8.50 after call');
  expectSeq(room.game.toAct,['Tommy'],'example: Tommy BB acts after Simon call');

  room=applyAction(room,'Tommy',{type:'raise',amount:4});
  assert.equal(room.players.Tommy.bet,4,'example: Tommy re-raises to total 4.00');
  assert.equal(room.players.Tommy.chips,6,'example: Tommy has 6.00 behind after re-raise');
  expectSeq(room.game.toAct,['Mark','Simon'],'example: re-raise wraps back to Mark, folded Lisa stays out');

  room=applyAction(room,'Mark',{type:'allin'});
  assert.equal(room.players.Mark.bet,10,'example: Mark all-in total is 10.00');
  expectSeq(room.game.toAct,['Simon','Tommy'],'example: Simon then Tommy respond to all-in');

  room=applyAction(room,'Simon',{type:'fold'});
  expectSeq(room.game.toAct,['Tommy'],'example: Simon folds and Tommy remains');

  room=applyAction(room,'Tommy',{type:'call'});
  assert.equal(room.players.Tommy.bet,10,'example: Tommy calls to total 10.00');
  assert.equal(room.game.pot,21.5,'example: final all-in pot is 21.50');
  expectSeq(room.game.toAct,[],'example: no more action when remaining players are all-in');

  const resultRoom={
    ...room,
    players:{
      ...room.players,
      Mark:{...room.players.Mark,chips:21.5},
      Simon:{...room.players.Simon,chips:8.5},
      Tommy:{...room.players.Tommy,chips:0},
      Lisa:{...room.players.Lisa,chips:10}
    }
  };
  const dealer=nextDealer(resultRoom);
  assert.equal(dealer,1,'example next round: Simon becomes dealer');
  const next=dealRound(Object.entries(resultRoom.players).map(([id,p])=>({id,...p})),dealer,2);
  assert.equal(next.game.sbSeat,3,'example next round: bust Tommy is skipped, Lisa is SB');
  assert.equal(next.game.bbSeat,0,'example next round: Mark is BB');
  expectSeq(next.game.toAct,['Simon','Lisa','Mark'],'example next round: first preflop actor is after BB, wrapping to Simon');
}

function runFuzzScenarios(){
  const seatSets=[
    [0,1],
    [0,3],
    [0,1,2],
    [0,2,7],
    [1,4,6,9],
    [0,2,3,5,8]
  ];

  for(const seats of seatSets){
    let players=seats.map((seat,i)=>makePlayer(`p${seat}`,seat,10+i));
    let dealer=Math.min(...seats);
    for(let round=1;round<=10;round++){
      const room=dealRound(players,dealer,round);
      const activeSeats=Object.values(room.players)
        .filter(p=>p.connected!==false&&p.chips>0)
        .map(p=>p.seatIndex)
        .sort((a,b)=>a-b);

      assert.ok(activeSeats.includes(room.game.dealerSeat),`fuzz ${seats}: dealer is active`);
      assert.ok(activeSeats.includes(room.game.sbSeat),`fuzz ${seats}: sb is active`);
      assert.ok(activeSeats.includes(room.game.bbSeat),`fuzz ${seats}: bb is active`);

      if(activeSeats.length===2){
        assert.equal(room.game.sbSeat,room.game.dealerSeat,`fuzz ${seats}: heads-up dealer is sb`);
      }else{
        assert.equal(room.game.sbSeat,nextSeatIn(activeSeats,room.game.dealerSeat),`fuzz ${seats}: sb after dealer`);
        assert.equal(room.game.bbSeat,nextSeatIn(activeSeats,room.game.sbSeat),`fuzz ${seats}: bb after sb`);
      }

      assertNoInvalidToAct(room,`fuzz ${seats} round ${round}`);
      dealer=nextDealer(room);
      players=Object.entries(room.players).map(([id,p])=>({id,...p}));
    }
  }
}

runFixedScenarios();
runAllInClosureAndSidePotScenario();
runUserExampleScenario();
runFuzzScenarios();

console.log('OK: simulated user example plus dealer/blinds, all-in closure, side pots, preflop/postflop turn order, raise reopen, offline parking, all-in skipping.');
