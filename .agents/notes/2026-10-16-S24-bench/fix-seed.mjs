// S24 脚手架修复：Secure cookie 下 curl 不可用——全 fetch 登录 + 手写 netscape jar；
// 并补齐 seed 未完成步（alice 授权/种子提交）。幂等：每步自查现状再动。
import fs from 'node:fs';
const BASE='http://127.0.0.1:3211';
const H={ 'content-type':'application/json', origin:BASE };
const sidOf=r=>(r.headers.getSetCookie?.()||[]).map(c=>c.split(';')[0]).find(c=>c.startsWith('ngt_sid='))||'';
const jar=(sid)=>`# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tTRUE\t0\t${sid.split('=')[0]}\t${sid.split('=')[1]}\n`;
const post=async(p,body,sid)=>{const r=await fetch(BASE+p,{method:'POST',headers:{...H,cookie:sid},body:JSON.stringify(body)});return {status:r.status,json:await r.json().catch(()=>({})),sid:sidOf(r)};};

// admin 登录（bootstrap 已消费，账号密码登录）
const la=await fetch(BASE+'/api/v1/auth/login',{method:'POST',headers:H,body:JSON.stringify({username:'admin',password:'Bench-Admin-2026!'})});
const admin=sidOf(la); console.log('admin login:',la.status,admin?'ok':'FAIL');
fs.writeFileSync('/tmp/bench-admin.jar',jar(admin));

// alice：先试既有密码，失败走管理员重置令牌
let lg=await fetch(BASE+'/api/v1/auth/login',{method:'POST',headers:H,body:JSON.stringify({username:'alice',password:'Alice-Bench-2026!x'})});
let alice=sidOf(lg);
if(!alice){
  const rt=await post('/api/v1/admin/employees/alice/password-reset',{},admin);
  const tok=rt.json.password_reset_token||rt.json.reset_token;
  const rr=await fetch(BASE+'/api/v1/auth/password-reset',{method:'POST',headers:H,body:JSON.stringify({reset_token:tok,new_password:'Alice-Bench-2026!x'})});
  console.log('alice reset:',rt.status,rr.status);
  lg=await fetch(BASE+'/api/v1/auth/login',{method:'POST',headers:H,body:JSON.stringify({username:'alice',password:'Alice-Bench-2026!x'})});
  alice=sidOf(lg);
}
console.log('alice login:',lg.status,alice?'ok':'FAIL');
fs.writeFileSync('/tmp/bench-alice.jar',jar(alice));

const vs=await (await fetch(BASE+'/api/v1/vaults',{headers:{cookie:admin}})).json();
const have=new Set((vs.vaults||[]).map(v=>v.slug));
for(const s of ['bench-big','bench-a','bench-b','bench-c']) if(!have.has(s))
  console.log('create',s,(await post('/api/v1/vaults',{slug:s,name:s},admin)).status);
for(const s of ['bench-big','bench-a','bench-b','bench-c']){
  const g=await fetch(BASE+`/api/v1/vaults/${s}/members/alice`,{method:'PUT',headers:{...H,cookie:admin},body:JSON.stringify({role:'editor'})});
  console.log('grant',s,g.status);
}
// bench-big 种子：500 文档 + 19 次修订
const st=await (await fetch(BASE+'/api/v1/vaults/bench-big/index-status',{headers:{cookie:alice}})).json();
if(st.head_commit){ console.log('bench-big 已有种子 head:',st.head_commit.slice(0,7)); }
else{
  const files=Array.from({length:500},(_,i)=>({path:`docs/d${String(i).padStart(3,'0')}.md`,content:`---\ntitle: 文档 ${i}\ntags: [bench, batch${i%10}]\n---\n\n# 文档 ${i}\n\n这是基准种子文档 ${i}。`.repeat(3)}));
  const c0=await post('/api/v1/vaults/bench-big/submissions',{base_commit:null,message:'seed: 500 docs',changes:files},alice);
  console.log('big seed:',c0.status,c0.json.commit?.slice(0,7));
  let head=c0.json.commit;
  for(let k=1;k<=19;k++){
    const rr=await post('/api/v1/vaults/bench-big/submissions',{base_commit:head,message:`seed edit ${k}`,changes:[{path:`docs/d${String(k*7%500).padStart(3,'0')}.md`,content:`---\ntitle: 文档 ${k*7%500} rev${k}\n---\n\n第 ${k} 次修订。`}]},alice);
    if(rr.status!==201){console.log('edit fail',k,rr.status);break;}
    head=rr.json.commit;
  }
  console.log('big history:',head?.slice(0,7));
}
// a/b/c 各 40 文档
for(const s of ['bench-a','bench-b','bench-c']){
  const st1=await (await fetch(BASE+`/api/v1/vaults/${s}/index-status`,{headers:{cookie:alice}})).json();
  if(st1.head_commit){console.log(s,'已种子');continue;}
  const fs40=Array.from({length:40},(_,i)=>({path:`docs/f${i}.md`,content:`---\ntitle: ${s}-${i}\n---\n\n${s} 文档 ${i}。`}));
  console.log(s,'seed:',(await post(`/api/v1/vaults/${s}/submissions`,{base_commit:null,message:'seed',changes:fs40},alice)).status);
}
console.log('FIX SEED DONE');
