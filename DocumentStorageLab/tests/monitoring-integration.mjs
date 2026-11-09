import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApi,waitReady} from './api-client.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','monitoring-'+run),checks=[];
const base='http://127.0.0.1:18390',prom='http://127.0.0.1:19381',grafana='http://127.0.0.1:19382';
const dc=(...args)=>execFileSync('docker',['compose','-p','dodc-document-lab-test','-f',path.join(root,'compose.yaml'),'-f',path.join(root,'tests/compose.test.yaml'),'-f',path.join(root,'monitoring/compose.yaml'),'--profile','monitoring',...args],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:'18390',PROMETHEUS_PORT:'19381',GRAFANA_PORT:'19382'},timeout:60000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(fn){let error;for(let n=0;n<50;n++){try{return await fn();}catch(e){error=e;}await sleep(1000);}throw error;}
async function query(expr){const response=await fetch(prom+'/api/v1/query?query='+encodeURIComponent(expr));assert.equal(response.status,200);const data=await response.json();assert.equal(data.status,'success');return data.data.result;}
async function check(name,fn){const details=await fn();checks.push({name,pass:true,...details});console.log('PASS',name);}
await mkdir(out,{recursive:true});
try{
 dc('up','-d','--no-build','api','api2','prometheus','grafana');const api=await createApi(base);
 await check('Prometheus scrapes both private API listeners',async()=>{await eventually(async()=>{const samples=await query('up{job="document-api"}');assert.equal(samples.length,2);assert.ok(samples.every(x=>x.value[1]==='1'));});const config=JSON.parse(execFileSync('docker',['inspect',dc('ps','-q','api').trim()],{encoding:'utf8'}))[0];assert.ok(!config.HostConfig.PortBindings||Object.keys(config.HostConfig.PortBindings).length===0);assert.equal((await api.request('/metrics')).status,404);return {targets:await query('up{job="document-api"}'),apiPortsNotPublished:true,publicMetricsStatus:404};});
 const payload=Buffer.from('Monitoring lab fixture; synthetic content only.\n');let doc;
 await check('Actual upload/download traffic and errors produce bounded route metrics',async()=>{
  const r=await api.json('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':'metrics-'+run+'.txt'},body:payload});assert.equal(r.status,201);doc=r.data;
  for(let i=0;i<24;i++){const response=await api.request('/api/files/'+doc.fid);assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),doc.sha256);}
  assert.equal((await api.request('/api/files/not-a-valid-fid')).status,400);
  await eventually(async()=>{const samples=await query('sum(dodc_http_requests_total{route="/api/files/:fid",status="200"})');assert.ok(Number(samples[0]?.value[1])>=24);});
  const counters=await query('dodc_http_requests_total'),histogram=await query('dodc_http_request_duration_seconds_count'),byteCounters=await query('dodc_document_bytes_total');
  assert.ok(counters.some(x=>x.metric.route==='/api/files/:fid'&&x.metric.status==='400'));assert.ok(!counters.some(x=>Object.values(x.metric).some(v=>v.includes(doc.fid)||v.includes(doc.name))));assert.ok(histogram.some(x=>Number(x.value[1])>0));assert.ok(byteCounters.some(x=>x.metric.direction==='upload'&&Number(x.value[1])>=payload.length));
  return {counters,histogram,byteCounters,document:doc,documentIdsExcludedFromLabels:true};
 });
 await check('Provisioned Grafana dashboard is read-only and uses the local datasource',async()=>{
  const dashboard=await eventually(async()=>{const r=await fetch(grafana+'/api/dashboards/uid/dodc-operations');assert.equal(r.status,200);return r.json();});assert.equal(dashboard.dashboard.panels.length,8);assert.equal(dashboard.meta.canEdit,false);
  const ds=await (await fetch(grafana+'/api/datasources/uid/dodc-prometheus')).json();assert.equal(ds.url,'http://prometheus:9090');assert.equal((await fetch(grafana+'/api/dashboards/db',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dashboard:dashboard.dashboard})})).status,403);
  await writeFile(path.join(out,'grafana-dashboard.json'),JSON.stringify(dashboard,null,2));return {panels:8,canEdit:false,anonymousWriteStatus:403,datasource:ds.url};
 });
 await check('Stopping one API raises an availability alert while its peer serves requests',async()=>{dc('stop','api2');try{
  await eventually(async()=>{const rows=await query('ALERTS{alertname="DocumentApiUnavailable",alertstate="firing",instance="api2:9100"}');assert.equal(rows.length,1);});
  await sleep(5500);const response=await api.request('/api/catalogue');assert.equal(response.status,200);assert.equal(response.headers.get('x-api-instance'),'api-1');return {alerts:await query('ALERTS{alertname="DocumentApiUnavailable"}'),peerStatus:response.status};
 }finally{dc('start','api2');await eventually(async()=>{const rows=await query('up{job="document-api"}');assert.equal(rows.length,2);assert.ok(rows.every(x=>x.value[1]==='1'));});}});
 await check('Database loss raises dependency alerts without marking live API listeners down',async()=>{dc('stop','catalogue');try{
  await eventually(async()=>{const rows=await query('ALERTS{alertname="DocumentDependencyUnavailable",alertstate="firing",dependency="catalogue"}');assert.equal(rows.length,2);});
  const up=await query('up{job="document-api"}');assert.ok(up.every(x=>x.value[1]==='1'));assert.equal((await api.request('/api/catalogue')).status,503);return {alerts:await query('ALERTS{alertname="DocumentDependencyUnavailable"}'),apiScrapes:up,catalogueStatus:503};
 }finally{dc('start','catalogue');await waitReady(base);}});
 await check('Alerts resolve after recovery and original content still matches its hash',async()=>{await eventually(async()=>{assert.equal((await query('ALERTS{alertstate="firing"}')).length,0);});const response=await api.request('/api/files/'+doc.fid);assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),doc.sha256);return {firingAlerts:0,restoredHash:doc.sha256};});
 const source={};for(const file of ['app/monitoring.mjs','app/server.mjs','monitoring/compose.yaml','monitoring/prometheus.yaml','monitoring/alerts.yaml','monitoring/dashboards/documents.json'])source[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
 await writeFile(path.join(out,'checks.json'),JSON.stringify({run,checks,sourceSHA256:source},null,2));console.log('EVIDENCE',out);
}catch(error){await writeFile(path.join(out,'failure.json'),JSON.stringify({checks,error:error.stack},null,2));throw error;}
