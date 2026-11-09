import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApi} from './api-client.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','performance-'+run);
const sha=b=>createHash('sha256').update(b).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),execute=promisify(execFile);
const variants=['single','two','single-wide','single-tight'],sizes=[4096,262144,1048576],concurrencies=[1,8],repetitions=3,uploadCount=16,readCount=64;
const results=[],deployments=[],samples=[];await mkdir(out,{recursive:true});
const dockerInfo=JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'}));
const environment={date:new Date().toISOString(),docker:{version:dockerInfo.ServerVersion,kernel:dockerInfo.KernelVersion,architecture:dockerInfo.Architecture,cpus:dockerInfo.NCPU,memoryBytes:dockerInfo.MemTotal},client:{node:process.version,platform:process.platform,architecture:process.arch},method:{variants,sizes,concurrencies,repetitions,uploadCount,readCount,warmupsPerSize:8,latency:'Full response body received; hash verification follows timer. Batch wall time includes verification.',percentile:'Nearest-rank p95 on successful samples; no confidence interval or SLA inferred.',order:'Variants sequential; workload order rotates across three repetitions. Docker main lab remains idle in background.',resources:'Single = .5 CPU/256 MiB; two = 2 x .5 CPU/256 MiB; single-wide = 1 CPU/512 MiB; single-tight = .25 CPU/128 MiB. MongoDB/storage caps fixed.',scope:'Authenticated loopback requests including gateway, scoped MongoDB sessions/catalogue/read activity, hashing and SeaweedFS replication 001. No physical data-centre claim.'}};
await writeFile(path.join(out,'environment.json'),JSON.stringify(environment,null,2));
function summary(rows,elapsed){const successes=rows.filter(x=>x.ok),sorted=successes.map(x=>x.ms).sort((a,b)=>a-b),q=p=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null;return {requests:rows.length,successes:successes.length,errors:rows.length-successes.length,elapsedSeconds:elapsed/1000,successfulRequestsPerSecond:successes.length/(elapsed/1000),medianMs:q(.5),p95Ms:q(.95),minMs:sorted[0]??null,maxMs:sorted.at(-1)??null,instances:Object.fromEntries([...new Set(rows.map(x=>x.instance))].map(i=>[i,rows.filter(x=>x.instance===i).length]))};}
async function batch(count,concurrency,fn){let next=0;const rows=Array(count),start=performance.now();await Promise.all(Array.from({length:Math.min(count,concurrency)},async()=>{while(next<count){const i=next++;rows[i]=await fn(i);}}));return {summary:summary(rows,performance.now()-start),samples:rows};}
try{
 for(const variant of variants){
  const project='dodc-document-lab-perf-'+variant+'-'+Date.now(),port='18420',base='http://127.0.0.1:'+port;
  const dc=(...args)=>execFileSync('docker',['compose','-p',project,'-f',path.join(root,'compose.yaml'),'-f',path.join(root,'experiments/performance',variant+'.yaml'),'-f',path.join(root,'tests/compose.restore.yaml'),...args],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:port},timeout:60000});
  let sampling=false,sampler,phase='initial';
  try{
   dc('up','-d','--no-build');const api=await createApi(base),services=variant==='two'?['api','api2']:['api'];
   const ids=dc('ps','-q').trim().split('\n').filter(Boolean),inspect=JSON.parse(execFileSync('docker',['inspect',...ids],{encoding:'utf8'}));
   const config=inspect.map(c=>({name:c.Name,service:c.Config.Labels['com.docker.compose.service'],image:c.Config.Image,imageID:c.Image,cpus:c.HostConfig.NanoCpus/1e9,memoryBytes:c.HostConfig.Memory,restarts:c.RestartCount}));
   assert.equal(config.filter(x=>['api','api2'].includes(x.service)).length,services.length);
   deployments.push({variant,project,port,containers:config});
   sampling=true;sampler=(async()=>{while(sampling){const sampledPhase=phase;try{const {stdout}=await execute('docker',['stats','--no-stream','--format','{{json .}}',...ids],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});samples.push({at:new Date().toISOString(),variant,phase:sampledPhase,containers:stdout.trim().split('\n').filter(Boolean).map(JSON.parse)});}catch(e){samples.push({at:new Date().toISOString(),variant,phase:sampledPhase,error:e.code||e.name});}if(sampling)await sleep(1000);}})();
   const payloads=new Map(),fixtures=new Map();
   for(const size of sizes){const bytes=Buffer.alloc(size);let seed=42;for(let i=0;i<size;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;bytes[i]=seed&255;}payloads.set(size,bytes);const r=await api.json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':'fixture-'+size+'.bin'},body:bytes});assert.equal(r.status,201);assert.equal(r.data.sha256,sha(bytes));fixtures.set(size,r.data);for(let j=0;j<8;j++){const response=await api.request('/api/files/'+r.data.fid);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),r.data.sha256);}}
   const cases=sizes.flatMap(size=>concurrencies.map(concurrency=>({size,concurrency})));
   for(let repetition=1;repetition<=repetitions;repetition++){
    const ordered=[...cases.slice(repetition-1),...cases.slice(0,repetition-1)];
    for(const {size,concurrency} of ordered){
     const payload=payloads.get(size),expected=fixtures.get(size),digest=expected.sha256;
     for(const operation of ['upload','download']){
      phase=`${operation}/${size}/${concurrency}/${repetition}`;
      const measured=await batch(operation==='upload'?uploadCount:readCount,concurrency,async i=>{const start=performance.now();let status=0,instance=null;try{
       const response=await api.request(operation==='upload'?'/api/files':'/api/files/'+expected.fid,operation==='upload'?{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':`perf-${repetition}-${size}-${concurrency}-${i}.bin`},body:payload}:{});status=response.status;instance=response.headers.get('x-api-instance');const body=Buffer.from(await response.arrayBuffer()),ms=performance.now()-start;
       if(operation==='upload'){const receipt=JSON.parse(body);return {i,status,instance,ms,ok:status===201&&receipt.sha256===digest&&receipt.bytes===size,failureKind:status===201?(receipt.sha256===digest&&receipt.bytes===size?null:'integrity'):'http',recoveryReceiptReturned:!!receipt.recoveryReceipt};}
       return {i,status,instance,ms,ok:status===200&&body.length===size&&sha(body)===digest,failureKind:status===200?(body.length===size&&sha(body)===digest?null:'integrity'):'http'};
      }catch(error){return {i,status,instance,ms:performance.now()-start,ok:false,error:error.name,failureKind:'transport'};}});
      const result={variant,project,operation,size,concurrency,repetition,fixtureSHA256:digest,...measured};results.push(result);await writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('MEASURED',variant,phase,'p95',measured.summary.p95Ms?.toFixed(1),'ms; errors',measured.summary.errors);
     }
    }
   }
   const metrics={};for(const service of services)metrics[service]=dc('exec','-T',service,'node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:9100/metrics');console.log(await r.text());");await writeFile(path.join(out,'metrics-'+variant+'.json'),JSON.stringify(metrics,null,2));
   const final=JSON.parse(execFileSync('docker',['inspect',...ids],{encoding:'utf8'}));deployments.at(-1).finalState=final.map(x=>({service:x.Config.Labels['com.docker.compose.service'],oomKilled:x.State.OOMKilled,restarts:x.RestartCount,status:x.State.Status}));
   const observed=new Set(results.filter(x=>x.variant===variant).flatMap(x=>Object.keys(x.summary.instances)).filter(x=>x!=='null'));assert.deepEqual([...observed].sort(),services.map((_,i)=>'api-'+(i+1)));
  }finally{sampling=false;if(sampler)await sampler;await writeFile(path.join(out,'resource-samples.json'),JSON.stringify(samples,null,2));await writeFile(path.join(out,'deployments.json'),JSON.stringify(deployments,null,2));dc('--profile','spare','down');}
 }
 const summaryRows=[];for(const variant of variants)for(const operation of ['upload','download'])for(const size of sizes)for(const concurrency of concurrencies){const selected=results.filter(x=>x.variant===variant&&x.operation===operation&&x.size===size&&x.concurrency===concurrency);assert.equal(selected.length,3);const median=values=>values.sort((a,b)=>a-b)[1];summaryRows.push({variant,operation,size,concurrency,runs:selected.length,errors:selected.reduce((n,x)=>n+x.summary.errors,0),medianRunP95Ms:median(selected.map(x=>x.summary.p95Ms)),medianRunThroughput:median(selected.map(x=>x.summary.successfulRequestsPerSecond)),runP95Ms:selected.map(x=>x.summary.p95Ms),runThroughput:selected.map(x=>x.summary.successfulRequestsPerSecond)});}
 const source={};for(const p of ['tests/performance.mjs','app/server.mjs','app/monitoring.mjs','compose.yaml','experiments/performance/nginx-single.conf',...variants.map(x=>'experiments/performance/'+x+'.yaml')])source[p]=sha(await readFile(path.join(root,p)));
 await writeFile(path.join(out,'summary.json'),JSON.stringify({run,groups:results.length,requests:results.reduce((n,x)=>n+x.summary.requests,0),summary:summaryRows,sourceSHA256:source},null,2));assert.ok(results.every(x=>x.samples.every(s=>s.failureKind!=='integrity')),'Integrity mismatches invalidate benchmark results.');console.log('EVIDENCE',out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:error.stack,completedGroups:results.length},null,2));throw error;}
