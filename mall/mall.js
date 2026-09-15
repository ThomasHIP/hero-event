const products={
 'prb-car':{name:'PRB Insurance — Car',price:645.21,redeem:200},
 'prb-pickup':{name:'PRB Insurance — Pick-up',price:967.28,redeem:200},
 'fume-exotic':{name:'YOU FUME — U Exotic Sunrise',price:249,redeem:100},
 'fume-orangery':{name:'YOU FUME — U Orangery',price:249,redeem:100},
 'fume-wild':{name:'YOU FUME — U Wild Sunset',price:249,redeem:100},
 'fume-flora':{name:'YOU FUME — U Flora Jazmin',price:249,redeem:100},
 'fume-vanilla':{name:'YOU FUME — U Vanilla Choco Candy',price:249,redeem:100}
};
const qty={prb:1,fume:1},cart={};
let currentSession=null;
function money(n){return'฿'+n.toLocaleString('en-US',{minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2})}
function changeQty(k,d){qty[k]=Math.max(1,Math.min(20,qty[k]+d));document.getElementById('q-'+k).textContent=qty[k]}
function addPrb(){const k=document.querySelector('input[name="prbType"]:checked').value;cart[k]=(cart[k]||0)+qty.prb;render();document.querySelector('.checkout').scrollIntoView({behavior:'smooth'})}
function addFume(){const k=document.querySelector('input[name="fumeScent"]:checked').value;cart[k]=(cart[k]||0)+qty.fume;render();document.querySelector('.checkout').scrollIntoView({behavior:'smooth'})}
function removeItem(k){delete cart[k];render()}
function render(){
 const box=document.getElementById('cart'),items=Object.entries(cart);
 if(!items.length){box.innerHTML='<div class="empty">Your cart is empty.</div>';document.getElementById('summary').innerHTML='';return}
 let subtotal=0,eligible=0;
 box.innerHTML=items.map(([k,q])=>{
   const p=products[k],line=p.price*q,pts=p.redeem*q;subtotal+=line;eligible+=pts;
   return `<div class="row"><span><b>${p.name}</b><br><span class="muted">${q} × ${money(p.price)} · ${pts} Points redemption</span><div class="cartActions"><button class="removeBtn" onclick="removeItem('${k}')">Remove / ลบ</button></div></span><strong>${money(line)}</strong></div>`;
 }).join('');
 document.getElementById('summary').innerHTML=`<div class="row"><span>Subtotal</span><strong>${money(subtotal)}</strong></div><div class="row"><span>Eligible HERO Points for this cart</span><strong>${eligible} Points = ${money(eligible)} discount</strong></div><div class="row total"><span>Final amount</span><strong>${currentSession?'Points wallet connection next':'Sign in first'}</strong></div>`;
}
function checkout(){
 if(!Object.keys(cart).length){alert('Please add an item to the cart first.');return}
 if(!currentSession){openLogin();return}
 alert('Signed in as '+currentSession.user.email+'. Next backend step: connect the live HERO Points wallet and payment settlement.');
}
render();

(()=>{const root=document.getElementById('heroMallSlider'),slides=[...root.querySelectorAll('.slide')],dots=[...root.querySelectorAll('.dot')];let i=0,t;
 function show(n){i=(n+slides.length)%slides.length;slides.forEach((s,k)=>s.classList.toggle('active',k===i));dots.forEach((d,k)=>d.classList.toggle('active',k===i))}
 function start(){clearInterval(t);t=setInterval(()=>show(i+1),5500)}
 root.querySelector('.prev').onclick=()=>{show(i-1);start()};root.querySelector('.next').onclick=()=>{show(i+1);start()};dots.forEach((d,k)=>d.onclick=()=>{show(k);start()});start()
})();

async function loadHQSlide(id,parts){
 try{
  const texts=await Promise.all(parts.map(p=>fetch(p+'?v=20260916hq',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('asset '+r.status);return r.text()})));
  const b64=texts.join('').replace(/\s/g,''),raw=atob(b64),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  document.getElementById(id).src=URL.createObjectURL(new Blob([bytes],{type:'image/webp'}));
 }catch(e){console.error('HQ slide load failed',id,e)}
}
loadHQSlide('heroSlide1',['/mall/assets/hq1-0.b64','/mall/assets/hq1-1.b64','/mall/assets/hq1-2.b64','/mall/assets/hq1-3.b64','/mall/assets/hq1-4.b64']);
loadHQSlide('heroSlide2',['/mall/assets/hq2-0.b64','/mall/assets/hq2-1.b64','/mall/assets/hq2-2.b64']);

const SB_URL='https://ajbuenoxbsfmwhydvlxd.supabase.co';
const SB_KEY='sb_publishable_oron-nE6v6FSF_YPckMCGA_4QHstvwm';
const sb=window.supabase.createClient(SB_URL,SB_KEY);

function openLogin(){document.getElementById('loginModal').classList.add('show');setTimeout(()=>document.getElementById('loginEmail').focus(),80)}
function closeLogin(){document.getElementById('loginModal').classList.remove('show')}
function backdropClose(e){if(e.target.id==='loginModal')closeLogin()}
async function sendLoginLink(){
 const email=document.getElementById('loginEmail').value.trim();
 const msg=document.getElementById('authMsg');
 if(!email){msg.textContent='Please enter your email.';return}
 msg.textContent='Sending secure login link...';
 const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:window.location.origin+'/mall/'}});
 if(error){msg.textContent='Could not send login link: '+error.message;return}
 msg.textContent='Login link sent. Please check your email, then tap the link to return to HERO Mall.';
}
async function refreshAuth(){
 const {data}=await sb.auth.getSession();currentSession=data.session||null;
 const strip=document.getElementById('loginStrip'),walletH=document.getElementById('walletHeadline'),walletS=document.getElementById('walletSub'),walletBtn=document.getElementById('walletLoginBtn'),checkoutBtn=document.getElementById('checkoutLoginBtn');
 if(currentSession){
  const email=currentSession.user.email||'Member';
  strip.textContent='✓ Signed in: '+email;strip.classList.add('signed');
  walletH.textContent='Signed in successfully.';walletS.textContent=email+' • Points wallet connection is the next backend step.';
  walletBtn.textContent='Sign Out';walletBtn.onclick=signOut;checkoutBtn.textContent='Signed in ✓';checkoutBtn.onclick=()=>{};
 }else{
  strip.textContent='👤 Member Sign In • เข้าสู่ระบบสมาชิก';strip.classList.remove('signed');
  walletH.textContent='Sign in to view your balance.';walletS.textContent='Use the same email you used to register with HERO Event.';
  walletBtn.textContent='Member Sign In';walletBtn.onclick=openLogin;checkoutBtn.textContent='Member Sign In / เข้าสู่ระบบ';checkoutBtn.onclick=openLogin;
 }
 render();
}
async function signOut(){await sb.auth.signOut();await refreshAuth()}
async function handleLoginStrip(){if(currentSession){if(confirm('Sign out from HERO Mall?'))await signOut()}else openLogin()}
sb.auth.onAuthStateChange(()=>refreshAuth());
refreshAuth();