import {createApi} from './api-client.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base='http://127.0.0.1:18390';
const run=new Date().toISOString().replace(/[:.]/g,'-');
const out=path.join(root,'evidence',`catalogue-${run}`);
await mkdir(out,{recursive:true});
const checks=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
function dc(...args){return execFileSync('docker',['compose','-p','dodc-document-lab-test','-f',path.join(root,'compose.yaml'),'-f',path.join(root,'tests/compose.test.yaml'),...args],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:'18390'},timeout:60000});}
const api=await createApi(base),json=api.json;
async function eventually(fn){let error;for(let n=0;n<60;n++){try{return await fn();}catch(e){error=e;await sleep(1000);}}throw error;}
async function check(name,fn){const detail=await fn();checks.push({name,pass:true,...detail});console.log('PASS',name);}
function importList(receipts){return json('/api/catalogue/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({format:'dodc-document-receipts',version:1,receipts})});}
async function rawFile(name,content){
 const script=`const a=await (await fetch('http://master:9333/dir/assign?replication=001')).json(); const form=new FormData();form.append('file',new Blob([Buffer.from(${JSON.stringify(content.toString('base64'))},'base64')]),${JSON.stringify(name)});const r=await fetch('http://'+a.url+'/'+a.fid,{method:'POST',body:form});if(!r.ok)throw Error('write failed');console.log(JSON.stringify({fid:a.fid}));`;
 const data=JSON.parse(dc('exec','-T','api','node','--input-type=module','-e',script));
 return {...data,name,bytes:content.length,sha256:hash(content),uploadedAt:new Date().toISOString()};
}
let receipt,legacy;
try{
 await eventually(async()=>assert.equal((await json('/api/ready')).status,200));
 await eventually(async()=>assert.ok((await json('/api/storage-status')).data.services.filter(x=>x.reachable).length>=2));
 await check('Catalogue starts empty or retains previous isolated test documents',async()=>{const r=await json('/api/catalogue');assert.equal(r.status,200);assert.equal(r.data.source,'shared-catalogue');return {initialCount:r.data.receipts.length};});
 const bytes=await readFile(path.join(root,'fixtures/sample-invoice.txt'));
 await check('Successful upload commits metadata and matching stored bytes',async()=>{
  const r=await json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':`catalogue-${run}.txt`},body:bytes});assert.equal(r.status,201);receipt=r.data;
  const list=(await json('/api/catalogue')).data.receipts;assert.deepEqual(list.find(x=>x.fid===receipt.fid),receipt);
  const downloaded=await api.request('/api/files/'+receipt.fid);assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())),receipt.sha256);return {receipt};
 });
 legacy=await rawFile(`legacy-${run}.txt`,Buffer.from('Synthetic legacy receipt migration\n'));
 await check('Uncatalogued legacy bytes are imported only after content verification',async()=>{const r=await importList([legacy]);assert.equal(r.status,200);assert.equal(r.data.added,1);return {legacy};});
 await check('Repeated and concurrent imports are idempotent',async()=>{const r=await Promise.all([importList([legacy,receipt]),importList([legacy,receipt])]);for(const x of r){assert.equal(x.status,200);assert.equal(x.data.added,0);}const list=(await json('/api/catalogue')).data.receipts;assert.equal(list.filter(x=>x.fid===legacy.fid).length,1);});
 await check('A stored upload whose metadata insert fails returns a verifiable recovery receipt',async()=>{
  dc('exec','-T','catalogue','mongosh','--quiet','--eval',"db.getSiblingDB('admin').auth('labAdmin',require('fs').readFileSync('/run/secrets/mongo_admin_password','utf8').trim());db.adminCommand({configureFailPoint:'failCommand',mode:{times:1},data:{failCommands:['insert'],errorCode:9}})");
  const r=await json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':`recovery-${run}.txt`},body:bytes});
  assert.equal(r.status,503);assert.ok(r.data.recoveryReceipt);
  const recovery=r.data.recoveryReceipt;
  assert.ok(!(await json('/api/catalogue')).data.receipts.some(x=>x.fid===recovery.fid));
  const restored=await importList([recovery]);assert.equal(restored.status,200);assert.equal(restored.data.added,1);return {recoveryReceipt:recovery};
 });
 await check('Forged hash and invalid metadata are rejected without partial import',async()=>{
  const next=await rawFile(`atomic-${run}.txt`,Buffer.from('Should not partially import\n'));
  const r=await importList([next,{...receipt,sha256:'0'.repeat(64)}]);assert.equal(r.status,422);
  assert.ok(!(await json('/api/catalogue')).data.receipts.some(x=>x.fid===next.fid));
  assert.equal((await importList([{...receipt,bytes:-1}])).status,400);
  assert.equal((await importList([receipt,{...receipt,sha256:'0'.repeat(64)}])).status,409);
 });
 await check('A transaction rolls back an earlier insert when a later catalogue conflict occurs',async()=>{
  const next=await rawFile(`rollback-${run}.txt`,Buffer.from('Transaction rollback test\n'));
  const set=`db.getSiblingDB('admin').auth('labAdmin',require('fs').readFileSync('/run/secrets/mongo_admin_password','utf8').trim());db.getSiblingDB('dodc_documents').receipts.updateOne({_id:${JSON.stringify(receipt.fid)}},{$set:{sha256:'${'0'.repeat(64)}'}})`;
  dc('exec','-T','catalogue','mongosh','--quiet','--eval',set);
  try {assert.equal((await importList([next,receipt])).status,409);assert.ok(!(await json('/api/catalogue')).data.receipts.some(x=>x.fid===next.fid));}
  finally {dc('exec','-T','catalogue','mongosh','--quiet','--eval',set.replace('0'.repeat(64),receipt.sha256));}
 });
 await check('Database outage keeps liveness but blocks catalogue and uploads',async()=>{
  dc('stop','catalogue');
  try {assert.equal((await json('/api/health')).status,200);assert.equal((await json('/api/ready')).status,503);assert.equal((await json('/api/catalogue')).status,503);assert.equal((await json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream'},body:bytes})).status,503);}
  finally {dc('start','catalogue');await eventually(async()=>assert.equal((await json('/api/ready')).status,200));}
 });
 await check('Catalogue and stored content survive database/API recreation',async()=>{
  const before=dc('ps','-q','api').trim();dc('up','-d','--no-build','--force-recreate','catalogue','catalogue-init','api');
  await eventually(async()=>assert.equal((await json('/api/ready')).status,200));
  const after=dc('ps','-q','api').trim();assert.notEqual(before,after);
  assert.ok((await json('/api/catalogue')).data.receipts.some(x=>x.fid===receipt.fid));
  const r=await api.request('/api/files/'+receipt.fid);assert.equal(hash(Buffer.from(await r.arrayBuffer())),receipt.sha256);return {before,after};
 });
 await writeFile(path.join(out,'receipts.json'),JSON.stringify({receipt,legacy},null,2));
 await writeFile(path.join(out,'checks.json'),JSON.stringify({run,project:'dodc-document-lab-test',checks,sourceSHA256:Object.fromEntries(await Promise.all(['app/server.mjs','app/catalogue.mjs','app/public/app.js','compose.yaml','init-replica.js'].map(async p=>[p,hash(await readFile(path.join(root,p)))])))},null,2));
 await writeFile(path.join(out,'services.txt'),dc('ps'));
 console.log('EVIDENCE',out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,error:error.stack},null,2));throw error;}
