import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {waitReady,createApi} from './api-client.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'evidence/deployment-main-'+new Date().toISOString().replace(/[:.]/g,'-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
await waitReady('http://127.0.0.1:18380');
const files=['server.mjs','catalogue.mjs','auth.mjs','database.mjs','monitoring.mjs','package.json','package-lock.json'];
const script="const f=require('node:fs'),h=require('node:crypto');console.log(JSON.stringify(Object.fromEntries("+JSON.stringify(files)+".map(p=>[p,h.createHash('sha256').update(f.readFileSync('/app/'+p)).digest('hex')]))))";
const checks=[];
for(const service of ['api','api2']) {
 const deployed=JSON.parse(execFileSync('docker',['compose','-p','dodc-document-lab','-f',path.join(root,'compose.yaml'),'exec','-T',service,'node','-e',script],{encoding:'utf8'}));
 for(const p of files){if(sha(await readFile(path.join(root,'app',p)))!==deployed[p])throw Error('Deployed backend mismatch: '+service+'/'+p);checks.push({service,file:p,pass:true,sha256:deployed[p]});}
}
for(const p of ['index.html','app.js','styles.css','pdf-preview.mjs','favicon.svg']){const response=await fetch('http://127.0.0.1:18380/'+(p==='index.html'?'':p));const actual=sha(Buffer.from(await response.arrayBuffer()));if(actual!==sha(await readFile(path.join(root,'app/public',p))))throw Error('Frontend mismatch: '+p);checks.push({file:p,pass:true,sha256:actual});}
const ready=await fetch('http://127.0.0.1:18380/api/ready');if(ready.status!==200)throw Error('Main catalogue not ready');
const api=await createApi('http://127.0.0.1:18380');
const originals=JSON.parse(await readFile(path.join(root,'evidence/ui-2026-10-08-overview/browser-receipts.json'),'utf8'));
const expected=Array.isArray(originals)?originals:originals.receipts;
let instances=new Set();
for(let n=0;n<30;n++) {
 instances=new Set();for(let i=0;i<12;i++){const r=await api.request('/api/catalogue');if(r.status===200)instances.add(r.headers.get('x-api-instance'));}
 if(instances.size===2)break;await new Promise(r=>setTimeout(r,1000));
}
if(instances.size!==2)throw Error('Main shared session did not reach both APIs.');
const current=(await api.json('/api/catalogue')).data.receipts;
for(const receipt of expected){if(!current.some(x=>x.fid===receipt.fid))throw Error('Original sample missing: '+receipt.name);const response=await api.request('/api/files/'+receipt.fid);if(!response.ok||sha(Buffer.from(await response.arrayBuffer()))!==receipt.sha256)throw Error('Original sample hash differs: '+receipt.name);}
await mkdir(out,{recursive:true});await writeFile(path.join(out,'deployment-check.json'),JSON.stringify({at:new Date().toISOString(),checks,instances:[...instances],originalSamplesVerified:expected.length,ready:await ready.json()},null,2));console.log('Verified',checks.length,'deployed source files, dependency readiness and',expected.length,'original sample hashes');console.log('EVIDENCE',out);
