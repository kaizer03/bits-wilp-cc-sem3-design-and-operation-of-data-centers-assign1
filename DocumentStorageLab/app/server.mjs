import express from 'express';
import {createAccess,AccessError} from './auth.mjs';
import { createHash } from 'node:crypto';
import { createCatalogue, CatalogueError, categories } from './catalogue.mjs';
import {createMonitoring} from './monitoring.mjs';

const app = express();
const catalogue = createCatalogue();
const access = createAccess(catalogue.database,catalogue.connect);
const master = process.env.MASTER_URL || 'http://master:9333';
const masters=(process.env.MASTER_URLS||master).split(',').map(x=>x.trim().replace(/\/$/,''));
if(!masters.length||masters.length>3||masters.some(x=>!/^http:\/\/master[23]?:9333$/.test(x)))throw new Error('Configure one to three local storage coordinator URLs.');
let preferredMaster=0;
const replication = process.env.REPLICATION || '001';
if(!/^[0-9]{3}$/.test(replication))throw new Error('Invalid replication policy.');
const requestedCopies=1+[...replication].reduce((n,digit)=>n+Number(digit),0);
const instance=process.env.API_INSTANCE||'api';
const monitoring=createMonitoring(instance,async()=>{
  const [metadata,storage]=await Promise.allSettled([catalogue.ready(),observeStorage()]);
  const reachable=storage.status==='fulfilled'?storage.value.services.filter(x=>x.registered&&x.reachable).length:0;
  return {catalogue:metadata.status==='fulfilled',coordinator:storage.status==='fulfilled',read_storage:reachable>0,write_service_count:reachable>=requestedCopies};
});
const allowedHosts = new Set(['volume1:8080', 'volume2:8080', 'volume3:8080']);
app.disable('x-powered-by');
app.use(monitoring.middleware);
app.use((_req,res,next)=>{
  res.set('X-API-Instance',instance);
  res.set('X-Content-Type-Options','nosniff');
  res.set('Referrer-Policy','no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; frame-src 'self' blob:; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.static('public'));
app.get('/api/health', (_req, res) => res.json({status: 'ok', replication, instance}));
app.get('/api/ready', async (_req,res)=>{
  const [metadata,storage]=await Promise.allSettled([catalogue.ready(),observeStorage()]);
  const catalogueReady=metadata.status==='fulfilled',coordinatorReachable=storage.status==='fulfilled';
  const reachable=coordinatorReachable?storage.value.services.filter(x=>x.registered&&x.reachable).length:0;
  const ready=catalogueReady&&coordinatorReachable&&reachable>0;
  res.status(ready?200:503).json({status:ready?'ready':'not-ready',instance,catalogueReady,coordinatorReachable,reachableStorageServices:reachable,requestedCopies,writeServiceCountSatisfied:reachable>=requestedCopies});
});
app.use('/api', (_req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.get('/api/auth/session',async(req,res)=>{
  try {const user=await access.identity(req);res.json({user});}
  catch {res.status(503).json({error:'Sign-in service is unavailable.'});}
});
app.post('/api/auth/login',express.json({limit:'8kb'}),async(req,res)=>{
  try {res.json({user:await access.login(req,res)});}
  catch(error){if(!(error instanceof AccessError))console.log(JSON.stringify({event:'sign_in_service_failed',instance,code:error.code,codeName:error.codeName,name:error.name}));res.status(error instanceof AccessError?error.status:503).json({error:error instanceof AccessError?error.message:'Sign-in service is unavailable.'});}
});
app.post('/api/auth/logout',async(req,res)=>{
  try {await access.logout(req,res);res.json({signedOut:true});}
  catch(error){res.status(error instanceof AccessError?error.status:503).json({error:error instanceof AccessError?error.message:'Sign-out could not be confirmed. Retry after database recovery.'});}
});
app.use('/api',access.middleware);
app.get('/api/catalogue', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({format: 'dodc-document-receipts', version: 1, source: 'shared-catalogue', categories, receipts: await catalogue.list(req.query.state)}); }
  catch { res.status(503).json({error: 'The shared catalogue is unavailable. Restore the database and retry.'}); }
});
app.get('/api/documents/:id', async (req, res) => {
  try { res.json(await catalogue.history(req.params.id)); }
  catch (err) { res.status(err instanceof CatalogueError ? err.status : 503).json({error: err instanceof CatalogueError ? err.message : 'Document history is unavailable.'}); }
});
app.patch('/api/documents/:id', express.json({limit: '8kb'}), async (req, res) => {
  try { res.json(await catalogue.change(req.params.id, req.body?.revision, req.body || {})); }
  catch (err) { res.status(err instanceof CatalogueError ? err.status : 503).json({error: err instanceof CatalogueError ? err.message : 'Document changes could not be committed. Refresh after database recovery.'}); }
});
app.get('/api/activity', async (_req, res) => {
  try { res.json({entries: await catalogue.activity()}); }
  catch { res.status(503).json({error: 'Activity history is unavailable.'}); }
});
app.post('/api/catalogue/import', express.json({limit: '1mb'}), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.body?.format !== 'dodc-document-receipts' || req.body?.version !== 1) return res.status(400).json({error: 'Choose a receipt export from this lab.'});
  try {
    const result = await catalogue.importReceipts(req.body.receipts, async item => {
      let bytes;
      try { ({bytes} = await readStoredFile(item.fid)); }
      catch { throw new CatalogueError('A receipt could not be verified against stored content. Nothing was imported.', 422); }
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
        throw new CatalogueError('A receipt does not match its stored content. Nothing was imported.', 422);
      }
    });
    res.json(result);
  } catch (err) {
    console.log(JSON.stringify({event: 'catalogue_import_failed', detail: err.message}));
    res.status(err instanceof CatalogueError ? err.status : 503).json({error: err instanceof CatalogueError ? err.message : 'The catalogue import could not be committed. Retry the same list after database recovery; existing receipts are retained.'});
  }
});

async function storageJson(path) {
  let error;
  for(let attempt=0;attempt<masters.length;attempt++){
    const index=(preferredMaster+attempt)%masters.length;
    try{
      const r=await fetch(`${masters[index]}${path}`,{signal:AbortSignal.timeout(masters.length>1?1500:4000)});
      const data=await r.json();
      if(!r.ok||data.error)throw new Error(data.error||`Storage status ${r.status}`);
      preferredMaster=index;return data;
    }catch(err){error=err;}
  }
  throw error;
}
function storageUrl(location, fid) {
  if (!allowedHosts.has(location)) throw new Error('Unexpected storage location');
  return `http://${location}/${fid}`;
}
async function observeStorage() {
  const status=await storageJson('/dir/status');
  const registered=(status.Topology?.DataCenters||[]).flatMap(x=>x.Racks||[]).flatMap(x=>x.DataNodes||[]);
  const services=await Promise.all(['volume1','volume2','volume3'].map(async name=>{
    const entry=registered.find(x=>x.Url===`${name}:8080`);let reachable=false;
    if(entry){try{reachable=(await fetch(`http://${name}:8080/status`,{signal:AbortSignal.timeout(1500)})).ok;}catch{}}
    return {name,registered:!!entry,reachable,volumeCopies:entry?.Volumes||0,maxVolumeSlots:entry?.Max||0};
  }));
  return {observedAt:new Date().toISOString(),coordinatorReachable:true,replication,requestedCopies,services};
}
app.get('/api/storage-status',async(_req,res)=>{
  try{res.json(await observeStorage());}
  catch{res.status(503).json({observedAt:new Date().toISOString(),coordinatorReachable:false,error:'Storage status is unavailable.'});}
});
app.post('/api/files', express.raw({type: 'application/octet-stream', limit: '5mb'}), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({error: 'Select a nonempty file below 5 MiB.'});
  let name;
  try { name = decodeURIComponent(req.get('x-file-name') || 'document.bin').replace(/[\x00-\x1f]/g, '').slice(0, 160); }
  catch { return res.status(400).json({error: 'Invalid filename.'}); }
  if (!name.trim()) return res.status(400).json({error: 'A nonempty filename is required.'});
  const type = req.get('x-file-type') || 'application/octet-stream';
  const documentId = req.get('x-document-id'), revision = Number(req.get('x-document-revision'));
  const category = req.get('x-document-category') || 'General';
  if (!categories.includes(category)) return res.status(400).json({error: 'Choose a valid category.'});
  let storedReceipt;
  try {
    await catalogue.preflight(documentId, revision);
    const assigned = await storageJson(`/dir/assign?replication=${replication}`);
    if (!assigned.fid) throw new Error('No writable storage available');
    const form = new FormData();
    form.append('file', new Blob([req.body], {type}), name);
    const stored = await fetch(storageUrl(assigned.url, assigned.fid), {method: 'POST', body: form, signal: AbortSignal.timeout(10000)});
    if (!stored.ok) throw new Error(`Storage write failed (${stored.status})`);
    const receipt = {fid: assigned.fid, name, bytes: req.body.length, sha256: createHash('sha256').update(req.body).digest('hex'), uploadedAt: new Date().toISOString()};
    storedReceipt = receipt;
    const published = await catalogue.publish(receipt, {documentId, revision, category});
    console.log(JSON.stringify({event: 'upload', fid: receipt.fid, bytes: receipt.bytes, replication, location: assigned.url}));
    res.status(201).json(published);
    monitoring.acknowledge('upload',receipt.bytes);
  } catch (err) {
    console.log(JSON.stringify({event: storedReceipt ? 'catalogue_publish_uncertain' : 'upload_failed', fid: storedReceipt?.fid, detail: err.message}));
    // Never delete bytes after an uncertain database acknowledgement: metadata may have committed.
    res.status(err instanceof CatalogueError ? err.status : 503).json({
      error: storedReceipt ? 'File contents were stored, but catalogue confirmation failed. Refresh the catalogue after database recovery before retrying.' : err instanceof CatalogueError ? err.message : 'Replicated storage is unavailable for this upload. Restore the storage services and try again.',
      ...(storedReceipt ? {recoveryReceipt: storedReceipt} : {})
    });
  }
});
async function readStoredFile(fid) {
  const {locations = []} = await storageJson(`/dir/lookup?volumeId=${fid.split(',')[0]}`);
  let failures = 0;
  for (const location of locations) {
    try {
      const response = await fetch(storageUrl(location.url, fid), {signal: AbortSignal.timeout(2500)});
      if (!response.ok) { failures++; continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      return {bytes, location: location.url, failures};
    } catch { failures++; }
  }
  throw new Error('No reachable replica');
}
app.get('/api/files/:fid', async (req, res) => {
  const fid = req.params.fid;
  if (!/^\d+,[a-f0-9]+$/i.test(fid)) return res.status(400).json({error: 'Invalid file identifier.'});
  try {
        const known = await catalogue.receipt(fid);
        if(!known)return res.status(404).json({error: 'File is not in the shared catalogue. An editor can import its verified receipt.'});
        const {bytes, location, failures} = await readStoredFile(fid);
        if (known && (known.bytes !== bytes.length || known.sha256 !== createHash('sha256').update(bytes).digest('hex'))) throw new Error('Stored content differs from catalogue');
        try { await catalogue.recordRead(fid); } catch (err) { console.log(JSON.stringify({event:'activity_write_failed',fid,detail:err.message})); }
        const name = String(req.query.name || 'document.bin').replace(/[\x00-\x1f]/g, '').slice(0, 160);
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.set('X-Storage-Service', location);
        res.set('X-Replica-Retries', String(failures));
        res.set('X-Content-SHA256', createHash('sha256').update(bytes).digest('hex'));
        console.log(JSON.stringify({event: 'download', fid, location, failures, bytes: bytes.length}));
        monitoring.acknowledge('download',bytes.length);
        monitoring.retried(failures);
        return res.send(bytes);
  } catch (err) {
    console.log(JSON.stringify({event: 'download_failed', fid, detail: err.message}));
    res.status(503).json({error: 'No reachable copy is available. Restore the storage services and retry.'});
  }
});
app.use((err, req, res, _next) => {
  const limit = req.path === '/api/catalogue/import' ? 'Receipt JSON must be below 1 MiB.' : req.path.startsWith('/api/documents/') ? 'The document change is too large.' : 'Maximum file size is 5 MiB.';
  res.status(err.type === 'entity.too.large' ? 413 : 400).json({error: err.type === 'entity.too.large' ? limit : 'The request could not be read.'});
});
const server = app.listen(3000, '0.0.0.0', () => console.log('Document storage lab listening on port 3000'));
process.on('SIGTERM', () => server.close(() => Promise.allSettled([catalogue.close(),monitoring.close()]).finally(() => process.exit(0))));
