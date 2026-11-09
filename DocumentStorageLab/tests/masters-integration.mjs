import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdir,writeFile,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createApi} from './api-client.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','masters-'+run),project='dodc-document-lab-masters-'+Date.now(),base='http://127.0.0.1:18430',checks=[],names=['master','master2','master3'];await mkdir(out,{recursive:true});
const dc=(...args)=>execFileSync('docker',['compose','-p',project,'-f',path.join(root,'compose.yaml'),'-f',path.join(root,'experiments/masters/compose.yaml'),'-f',path.join(root,'tests/compose.restore.yaml'),...args],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:'18430'},timeout:60000});
const internal=s=>JSON.parse(dc('exec','-T','api','node','--input-type=module','-e',s).trim()),hash=b=>createHash('sha256').update(b).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const cluster=()=>internal(`const result=await Promise.all(${JSON.stringify(names)}.map(async name=>{try{const r=await fetch('http://'+name+':9333/cluster/status',{signal:AbortSignal.timeout(1200)});return {name,status:r.status,...await r.json()};}catch(e){return {name,error:e.name};}}));console.log(JSON.stringify(result));`);
async function eventually(fn){let error;for(let n=0;n<60;n++){try{return await fn();}catch(e){error=e;}await sleep(1000);}throw error;}
async function check(name,fn){checks.push({name,pass:true,...await fn()});console.log('PASS',name);}
let api,document,leader,newLeader;
try{
 dc('up','-d','--no-build');api=await createApi(base);const bytes=Buffer.from('Three-master synthetic recovery fixture\n');
 const upload=name=>api.json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':name},body:bytes});
 await check('Three master peers agree on one leader and replicated content is readable',async()=>{const status=await eventually(async()=>{const states=cluster();assert.equal(states.filter(x=>x.status===200).length,3);assert.equal(states.filter(x=>x.IsLeader).length,1);assert.equal(new Set(states.map(x=>x.Leader)).size,1);return states;});leader=status.find(x=>x.IsLeader).name;const r=await upload('masters-original.txt');assert.equal(r.status,201);document=r.data;const read=await api.request('/api/files/'+document.fid);assert.equal(read.status,200);assert.equal(hash(Buffer.from(await read.arrayBuffer())),document.sha256);return {status,document,leader};});
 await check('Leader loss elects a survivor and the same API configuration recovers reads and writes',async()=>{
  const start=performance.now();dc('stop',leader);const probes=[];
  await eventually(async()=>{const response=await api.request('/api/files/'+document.fid);probes.push({afterMs:performance.now()-start,status:response.status});assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),document.sha256);const states=cluster(),elected=states.filter(x=>x.IsLeader&&x.status===200);assert.equal(elected.length,1);assert.notEqual(elected[0].name,leader);newLeader=elected[0].name;});
  const r=await eventually(async()=>{const value=await upload('after-leader-loss.txt');assert.equal(value.status,201);return value;});
  return {stopped:leader,newLeader,readAndNewLeaderObservedAfterMs:probes.at(-1).afterMs,firstSuccessfulReadAfterMs:probes.find(x=>x.status===200)?.afterMs,probes,newWriteStatus:r.status,mastersReconfigured:false};
 });
 await check('Losing two peers prevents fresh allocation; existing bytes remain on storage services',async()=>{
  const other=names.find(x=>x!==leader&&x!==newLeader);dc('stop',other);await sleep(12000);
  const states=cluster();assert.equal(states.filter(x=>x.status===200).length,1);
  const assignment=internal(`try{const r=await fetch('http://${newLeader}:9333/dir/assign?replication=001&collection=quorum-${run}',{signal:AbortSignal.timeout(6000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));}catch(e){console.log(JSON.stringify({error:e.name}));}`);
  // A fresh collection forces new volume allocation rather than reusing cached placement.
  assert.ok(assignment.error||assignment.status!==200||!JSON.parse(assignment.body).fid);
  const publicRead=await api.request('/api/files/'+document.fid),newUpload=await upload('during-quorum-loss.txt');
  const direct=internal(`const r=await fetch('http://volume1:8080/${document.fid}',{signal:AbortSignal.timeout(2500)});const b=Buffer.from(await r.arrayBuffer());console.log(JSON.stringify({status:r.status,sha256:(await import('node:crypto')).createHash('sha256').update(b).digest('hex')}));`);assert.equal(direct.status,200);assert.equal(direct.sha256,document.sha256);
  return {stopped:[leader,other],states,freshCollectionAssignment:assignment,applicationExistingReadStatus:publicRead.status,applicationExistingCollectionUploadStatus:newUpload.status,cachedPlacementBehaviourMeasured:true,directStoredContent:direct};
 });
 await check('Restoring peers recovers a single leader and preserves original content',async()=>{dc('start',...names);const states=await eventually(async()=>{const s=cluster();assert.equal(s.filter(x=>x.status===200).length,3);assert.equal(s.filter(x=>x.IsLeader).length,1);return s;});await eventually(async()=>{const r=await api.request('/api/files/'+document.fid);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),document.sha256);const write=await upload('after-quorum-recovery.txt');assert.equal(write.status,201);});return {states,originalSHA256:document.sha256};});
 const sources={};for(const p of ['app/server.mjs','experiments/masters/compose.yaml','tests/masters-integration.mjs'])sources[p]=hash(await readFile(path.join(root,p)));await writeFile(path.join(out,'checks.json'),JSON.stringify({run,project,checks,sourceSHA256:sources,logicalPeersOnOneHost:true},null,2));console.log('EVIDENCE',out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,project,error:error.stack},null,2));throw error;}
finally{dc('down');}
