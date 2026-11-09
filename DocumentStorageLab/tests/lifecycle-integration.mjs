import {createApi} from './api-client.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),base='http://127.0.0.1:18390',run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','lifecycle-'+run);
await mkdir(out,{recursive:true});const checks=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
const api=await createApi(base),json=api.json;
const upload=(name,bytes,headers={})=>json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':name,...headers},body:Buffer.from(bytes)});
const change=(doc,action,category)=>json('/api/documents/'+doc.documentId,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({revision:doc.revision,action,category})});
const history=doc=>json('/api/documents/'+doc.documentId);
async function check(name,fn){const detail=await fn();checks.push({name,pass:true,...detail});console.log('PASS',name);}
let doc,v2;
try{
 await check('New document has a stable identity, category and first immutable version',async()=>{const r=await upload('contract-'+run+'.txt','Contract draft 1\n',{'x-document-category':'Contracts'});assert.equal(r.status,201);doc=r.data;assert.equal(doc.documentId,doc.fid);assert.equal(doc.version,1);assert.equal(doc.category,'Contracts');return {document:doc};});
 await check('A revision adds new bytes without replacing the original',async()=>{const r=await upload('contract-'+run+'.txt','Contract draft 2\n',{'x-document-id':doc.documentId,'x-document-revision':String(doc.revision)});assert.equal(r.status,201);v2=r.data;assert.equal(v2.documentId,doc.documentId);assert.notEqual(v2.fid,doc.fid);assert.equal(v2.version,2);assert.equal(v2.category,'Contracts');const h=await history(v2);assert.equal(h.data.versions.length,2);for(const x of [doc,v2]){const r=await api.request('/api/files/'+x.fid);assert.equal(hash(Buffer.from(await r.arrayBuffer())),x.sha256);}return {version:v2};});
 await check('Stale revisions cannot overwrite a newer document',async()=>{const r=await upload('stale.txt','Wrong old revision',{'x-document-id':doc.documentId,'x-document-revision':String(doc.revision)});assert.equal(r.status,409);assert.equal((await history(v2)).data.versions.length,2);});
 await check('Concurrent category changes have one winner and one conflict',async()=>{const r=await Promise.all([change(v2,'category','Invoices'),change(v2,'category','Internal')]);assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);v2=(await history(v2)).data;return {category:v2.category};});
 await check('Trash hides the active document and preserves every version',async()=>{const r=await change(v2,'trash');assert.equal(r.status,200);v2=r.data;assert.ok(v2.deletedAt);assert.ok(!(await json('/api/catalogue')).data.receipts.some(x=>x.documentId===v2.documentId));assert.ok((await json('/api/catalogue?state=trash')).data.receipts.some(x=>x.documentId===v2.documentId));assert.equal((await history(v2)).data.versions.length,2);assert.equal((await upload('blocked.txt','No version in trash',{'x-document-id':v2.documentId,'x-document-revision':String(v2.revision)})).status,409);});
 await check('Restore returns the same document and version history',async()=>{const r=await change(v2,'restore');assert.equal(r.status,200);v2=r.data;assert.equal(v2.deletedAt,null);assert.equal((await history(v2)).data.versions.length,2);assert.ok((await json('/api/catalogue')).data.receipts.some(x=>x.documentId===v2.documentId));});
 await check('Invalid categories and malformed mutation requests are rejected',async()=>{assert.equal((await change(v2,'category','Made-up')).status,400);assert.equal((await change(v2,'destroy')).status,400);assert.equal((await json('/api/documents/'+v2.documentId,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action:'trash'})})).status,400);});
 await check('Committed lifecycle activity survives an API restart',async()=>{execFileSync('docker',['compose','-p','dodc-document-lab-test','-f',path.join(root,'compose.yaml'),'-f',path.join(root,'tests/compose.test.yaml'),'restart','api'],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:'18390'},timeout:60000});let r;for(let n=0;n<30;n++){try{r=await json('/api/activity');if(r.status===200)break;}catch{}await new Promise(f=>setTimeout(f,1000));}assert.equal(r.status,200);assert.ok(r.data.entries.some(x=>x.documentId===v2.documentId&&x.action==='Document restored'));assert.equal((await history(v2)).data.versions.length,2);});
 await writeFile(path.join(out,'checks.json'),JSON.stringify({run,checks,sourceSHA256:Object.fromEntries(await Promise.all(['app/server.mjs','app/catalogue.mjs','app/public/app.js'].map(async p=>[p,hash(await readFile(path.join(root,p)))])))},null,2));console.log('EVIDENCE',out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,error:error.stack},null,2));throw error;}
