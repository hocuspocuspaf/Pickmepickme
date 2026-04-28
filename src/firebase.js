import{initializeApp}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import{getDatabase,ref,set,get,update,onValue,onDisconnect}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import{getAuth,signInAnonymously,onAuthStateChanged}from'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

export{ref,set,get,update,onValue,onDisconnect};

export async function initFirebase(){
  const app=initializeApp({
    apiKey:"AIzaSyAPDqgBlrfSn43MlQXNMIDnGU8B4KD-ch0",
    authDomain:"tafel-van-simon.firebaseapp.com",
    databaseURL:"https://tafel-van-simon-default-rtdb.europe-west1.firebasedatabase.app",
    projectId:"tafel-van-simon",
    storageBucket:"tafel-van-simon.firebasestorage.app",
    messagingSenderId:"39838914763",
    appId:"1:39838914763:web:1403ac706d1f3dce8ae34e"
  });
  const db=getDatabase(app);
  const auth=getAuth(app);
  const user=await ensureSignedIn(auth);
  return{db,auth,myId:user.uid};
}

function ensureSignedIn(auth){
  return new Promise((resolve,reject)=>{
    const unsub=onAuthStateChanged(auth,user=>{
      if(user){
        unsub();
        resolve(user);
        return;
      }
      signInAnonymously(auth).catch(reject);
    },reject);
  });
}
