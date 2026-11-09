import {createServer} from 'node:http';
import {Registry, Counter, Histogram, Gauge, collectDefaultMetrics} from '@prometheus-io/client';

export function createMonitoring(instance, dependencyStatus) {
  const registry = new Registry();
  registry.setDefaultLabels({api_instance: instance});
  collectDefaultMetrics({register: registry, prefix: 'dodc_'});
  const requests = new Counter({name:'dodc_http_requests_total',help:'Completed API requests, including rejected requests.',labelNames:['method','route','status'],registers:[registry]});
  const duration = new Histogram({name:'dodc_http_request_duration_seconds',help:'API response duration; includes authentication, metadata and storage work.',labelNames:['method','route','status'],buckets:[.005,.01,.025,.05,.1,.25,.5,1,2.5,5,10,20],registers:[registry]});
  const bytes = new Counter({name:'dodc_document_bytes_total',help:'Document payload bytes in successful API response attempts. Excludes replication overhead.',labelNames:['direction'],registers:[registry]});
  const retries = new Counter({name:'dodc_replica_read_retries_total',help:'Failed storage locations before a successful file read.',registers:[registry]});
  new Gauge({name:'dodc_dependency_ready',help:'Observed dependency readiness at scrape time; not a write placement guarantee.',labelNames:['dependency'],registers:[registry],async collect(){
    const states=await dependencyStatus();
    for(const [dependency,value] of Object.entries(states))this.set({dependency},value?1:0);
  }});
  const routes=[/^\/api\/files\/[^/]+$/, /^\/api\/documents\/[^/]+$/];
  const known=new Set(['/api/health','/api/ready','/api/auth/session','/api/auth/login','/api/auth/logout','/api/catalogue','/api/catalogue/import','/api/activity','/api/storage-status','/api/files']);
  function middleware(req,res,next) {
    if(!req.path.startsWith('/api/'))return next();
    const route=known.has(req.path)?req.path:routes[0].test(req.path)?'/api/files/:fid':routes[1].test(req.path)?'/api/documents/:id':'other';
    const method=['GET','POST','PATCH','HEAD','OPTIONS'].includes(req.method)?req.method:'other';
    const start=process.hrtime.bigint();let recorded=false;
    const record=()=>{if(recorded)return;recorded=true;const labels={method,route,status:String(res.writableFinished?res.statusCode:499)};requests.inc(labels);duration.observe(labels,Number(process.hrtime.bigint()-start)/1e9);};
    res.once('finish',record);res.once('close',record);next();
  }
  // A separate un-published listener is reachable only on the isolated monitoring network.
  const server=createServer(async(req,res)=>{
    if(req.method!=='GET'||req.url!=='/metrics'){res.writeHead(404);res.end();return;}
    try{const body=await registry.metrics();res.writeHead(200,{'Content-Type':registry.contentType});res.end(body);}
    catch{res.writeHead(503);res.end('Metrics collection unavailable\n');}
  }).listen(9100,'0.0.0.0');
  return {middleware,acknowledge(direction,size){bytes.inc({direction},size);},retried(count){retries.inc(count);},close(){return new Promise(resolve=>server.close(resolve));}};
}
