'use strict';
const $ = selector => document.querySelector(selector);
const key = 'dodc-lab-receipts-v1', maxBytes = 5 * 1024 * 1024;
const verified = new Set();
let currentUser = null, pdfPreview = null;
let receipts = [], selected = [], busy = false, activeReceipt = null, previewUrl = null, catalogueReady = false, legacyReceipts = [], recoveryReceipts = [], revisionTarget = null;
function fileKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'pdf' ? 'pdf' : ['png','jpg','jpeg','gif','webp','bmp'].includes(ext) ? 'image' : ['txt','md','csv','log','json'].includes(ext) ? 'text' : 'other';
}
function size(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MiB`; }
function when(date) {return new Date(date).toLocaleString(undefined, {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function node(tag, text, className) {const n = document.createElement(tag);if(text !== undefined)n.textContent = text;if(className)n.className = className;return n;}
function notice(message, tone = 'success') {$('#status').textContent = message;$('#status').dataset.tone = tone;$('#status').className = `alert alert-${tone === 'error' ? 'danger' : tone === 'warn' ? 'warning' : 'success'} py-2`;$('#status').hidden = false;}
function feedback(target, message, tone = '') {$(target).textContent = message;$(target).dataset.tone = tone;$(target).className = `small mt-3 mb-0 ${tone === 'error' ? 'text-danger' : 'text-body-secondary'}`;}
const activities=[];
function logActivity(action, detail, tone='success') {
  activities.unshift({action,detail,tone,at:new Date()});activities.splice(8);
  const list=$('#activity-list');list.replaceChildren();$('#activity-empty').hidden=true;
  for(const entry of activities){const li=node('li');li.dataset.tone=entry.tone;li.append(node('strong',entry.action),node('span',entry.detail),node('time',entry.at.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})));list.append(li);}
}
function renderStorageOverview(data) {
  const services=data?.services || [], count=services.filter(x=>x.registered&&x.reachable).length, copies=data?.requestedCopies||2;
  $('#reachable-count').textContent=data?`${count} / ${services.length}`:'—';
  $('#overview-storage-note').textContent=data?'Registered services responding':'No current storage observation';
  $('#overview-state').textContent=data?(count>=copies?'Storage connected':count===1?'Limited storage':'Storage unavailable'):'Status unavailable';
  $('#overview-state').dataset.tone=data?(count>=copies?'success':count===1?'warn':'error'):'error';
  $('#replication-overview').textContent=data?`${data.replication} · ${copies} ${copies===1?'copy':'copies'}`:'—';
  $('#overview-slots').textContent=data?services.filter(x=>x.registered).reduce((n,x)=>n+x.maxVolumeSlots,0):'—';
  const list=$('#overview-nodes');list.replaceChildren();
  for(const service of services){const available=service.registered&&service.reachable, li=node('li');li.dataset.tone=available?'success':service.registered?'error':'neutral';li.append(node('code',service.name),node('span',available?'Reachable':service.registered?'Not reachable':'Not registered'));list.append(li);}
  if(!data)list.append(node('li','Retry after the coordinator is available.','observation-empty'));
}
function validateReceipt(item) {
  if (!item || typeof item !== 'object' || typeof item.fid !== 'string' || !/^\d+,[a-f0-9]+$/i.test(item.fid) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160 || /[\x00-\x1f]/.test(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > maxBytes || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256) || typeof item.uploadedAt !== 'string' || !Number.isFinite(Date.parse(item.uploadedAt))) throw Error('The receipt file contains an invalid document entry. No receipts were imported.');
  return {fid:item.fid,name:item.name,bytes:item.bytes,sha256:item.sha256.toLowerCase(),uploadedAt:item.uploadedAt,
    ...(item.documentId ? {documentId:item.documentId,version:item.version,revision:item.revision,category:item.category,deletedAt:item.deletedAt,updatedAt:item.updatedAt} : {})};
}
try {
  const stored = JSON.parse(localStorage.getItem(key) || '[]');
  if (!Array.isArray(stored) || stored.length > 1000) throw Error('Invalid saved receipts');
  receipts = stored.map(validateReceipt);
} catch {notice('Saved receipts could not be read. You can recover the list from an exported receipt file.', 'warn');}
legacyReceipts = receipts;
receipts = [];
async function refreshCatalogue(quiet = false) {
  if(!currentUser)return false;
  try {
    const response = await apiFetch('/api/catalogue?state='+$('#catalogue-state-filter').value, {signal: AbortSignal.timeout(7000), cache: 'no-store'});
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'The catalogue could not be loaded.');
    const current = data.receipts.map(validateReceipt);
    receipts = current; catalogueReady = true;
    $('#catalogue-state').textContent = 'Shared catalogue connected';
    $('#catalogue-state').className = 'badge text-bg-success';
    const known = new Map(receipts.map(x => [x.fid, x]));
    $('#migration-notice').hidden = !legacyReceipts.some(x => !known.has(x.fid));
    $('#catalogue-refresh').disabled = false;
    render(); refreshActivity(); return true;
  } catch (error) {
    catalogueReady = false;
    $('#catalogue-state').textContent = 'Catalogue unavailable';
    $('#catalogue-state').className = 'badge text-bg-danger';
    render(); if (!quiet) notice(error.message, 'error'); return false;
  }
}
async function importToCatalogue(incoming) {
  const response = await apiFetch('/api/catalogue/import', {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({format:'dodc-document-receipts',version:1,receipts:incoming}), signal: AbortSignal.timeout(180000)});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'Receipt import failed.');
  await refreshCatalogue(true); return data;
}
$('#catalogue-refresh').onclick = () => refreshCatalogue();
$('#migrate-legacy').onclick = async () => {
  const button = $('#migrate-legacy'); button.disabled = true;
  try {
    const result = await importToCatalogue(legacyReceipts);
    logActivity('Previous receipts migrated', `${result.added} added; stored contents verified`);
    notice(`${result.added} documents added to the shared catalogue. Previous browser receipts remain intact.`);
  } catch (error) { notice(error.message, 'error'); }
  finally {button.disabled = false;}
};
function render() {
  $('#nav-count').textContent = $('#document-count').textContent = $('#library-count').textContent = receipts.length;
  $('#total-size').textContent = size(receipts.reduce((sum, x) => sum + x.bytes, 0));
  $('#verified-count').textContent = receipts.filter(x => verified.has(x.fid)).length;
  $('#export').disabled = !receipts.length;
  $('#upload-open').disabled = $('#empty-upload').disabled = !catalogueReady;
  for(const id of ['upload-open','import-open','migrate-legacy','recover-uploads'])$('#'+id).hidden=currentUser?.role!=='editor';
  const query = $('#search').value.trim().toLowerCase(), kind = $('#type-filter').value;
  const category = $('#category-filter').value;
  const filtered = receipts.filter(x => (category === 'all' || x.category === category) && (x.name.toLowerCase().includes(query) || x.fid.toLowerCase().includes(query)) && (kind === 'all' || fileKind(x.name) === kind));
  const order = $('#sort').value;
  filtered.sort((a,b) => order === 'name' ? a.name.localeCompare(b.name) : order === 'size' ? b.bytes-a.bytes : order === 'oldest' ? Date.parse(a.uploadedAt)-Date.parse(b.uploadedAt) : Date.parse(b.uploadedAt)-Date.parse(a.uploadedAt));
  const rows = $('#files');rows.replaceChildren();
  for (const item of filtered) {
    const tr = node('tr'), cell = node('td'), info = node('div', undefined, 'document-cell');
    const type = fileKind(item.name), ext = item.name.split('.').pop().slice(0,4).toUpperCase();
    const glyph=node('span',undefined,'file-icon');glyph.dataset.kind=type;glyph.setAttribute('aria-hidden','true');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 32 40');
    const outline=document.createElementNS(svg.namespaceURI,'path');outline.setAttribute('d','M7 2h12l8 8v27H7z');outline.setAttribute('fill','currentColor');outline.setAttribute('fill-opacity','.04');outline.setAttribute('stroke','currentColor');outline.setAttribute('stroke-width','1.3');
    const fold=document.createElementNS(svg.namespaceURI,'path');fold.setAttribute('d','M19 2v8h8');fold.setAttribute('fill','none');fold.setAttribute('stroke','currentColor');fold.setAttribute('stroke-width','1.3');svg.append(outline,fold);glyph.append(svg,node('span',ext||'FILE'));info.append(glyph);
    const label = node('div'), title = node('button', item.name, 'btn btn-link btn-sm p-0 text-start document-name');title.title = item.name;title.onclick = () => openDetails(item);label.append(title,node('small',`${item.category || 'General'} · Version ${item.version || 1}`,'d-block text-body-secondary')); info.append(label);cell.append(info);tr.append(cell,node('td',size(item.bytes),'text-body-secondary text-nowrap'),node('td',when(item.uploadedAt),'text-body-secondary text-nowrap'));
    const state = node('td');state.append(node('span',verified.has(item.fid) ? '✓ Verified' : 'Not checked',`integrity${verified.has(item.fid) ? ' verified' : ''}`));tr.append(state);
    const actions = node('td'), buttons = node('div',undefined,'d-flex justify-content-end gap-2 row-actions');
    const details = node('button','Details','btn btn-outline-secondary btn-sm');details.setAttribute('aria-label',`View details of ${item.name}`);details.onclick = () => openDetails(item);
    const download = node('button','Download','btn btn-outline-primary btn-sm');download.onclick = () => downloadFile(item,download);buttons.append(details,download);actions.append(buttons);tr.append(actions);rows.append(tr);
  }
  $('.table-wrap').hidden = !filtered.length;$('#empty').hidden = !!filtered.length;
  $('#empty h3').textContent = receipts.length ? 'No matching documents' : catalogueReady ? 'No documents recorded' : 'Catalogue unavailable';
  $('#empty p').textContent = receipts.length ? 'Try another filename or identifier, or choose a different file type.' : catalogueReady ? 'Add an invoice, a PDF or an image. Documents will be visible in every browser connected to this lab.' : 'Retry the shared catalogue after the database is available. Previous documents have not been removed.';
  $('#empty-upload').hidden = !!receipts.length || currentUser?.role!=='editor';
  $('#result-count').textContent = `${filtered.length} of ${receipts.length} documents`;
}
async function retrieve(item) {
  const response = await apiFetch(`/api/files/${encodeURIComponent(item.fid)}?name=${encodeURIComponent(item.name)}`,{signal:AbortSignal.timeout(20000)});
  if(!response.ok){const data = await response.json().catch(()=>({}));throw Error(data.error || 'The document could not be retrieved. Please try again.');}
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
  if(hash !== item.sha256 || bytes.byteLength !== item.bytes) throw Error('File verification failed. The retrieved contents do not match this receipt.');
  verified.add(item.fid);render();return bytes;
}
function saveBlob(blob,name) {const url = URL.createObjectURL(blob), a = node('a');a.href = url;a.download = name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function downloadFile(item,button,detail = false) {
  button.disabled = true;
  if(detail)$('#details-dialog').focus();
  if(detail)feedback('#detail-feedback','Retrieving and verifying file contents…');else notice('Retrieving and verifying file contents…');
  try {const bytes = await retrieve(item);saveBlob(new Blob([bytes],{type:'application/octet-stream'}),item.name);notice(`Downloaded ${item.name}. File contents verified.`);logActivity('Download verified',item.name);if(detail)feedback('#detail-feedback','Download succeeded. File contents verified.');}
  catch(e){logActivity('Download failed',`${item.name}: ${e.message}`,'error');notice(e.message,'error');if(detail)feedback('#detail-feedback',e.message,'error');}
  finally {button.disabled = false;refreshStorage();}
}
function releasePreview() {if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl = null;if(pdfPreview)pdfPreview.destroy().catch(()=>{});pdfPreview=null;}
function openDetails(item) {
  activeReceipt = item;releasePreview();
  $('#document-category').value=item.category || 'General';
  $('#document-controls').hidden=!item.documentId;
  $('#edit-controls').hidden=currentUser?.role!=='editor';
  $('#new-version').hidden=$('#move-trash').hidden=$('#save-category').hidden=!!item.deletedAt;
  $('#restore-document').hidden=!item.deletedAt;
  $('#version-list').replaceChildren();
  if(item.documentId) loadHistory(item);$('#details-title').textContent = item.name;$('#detail-hash').textContent = item.sha256;
  const meta = $('#detail-meta');meta.replaceChildren();
  for(const [label,value] of [['File size',size(item.bytes)],['Uploaded',when(item.uploadedAt)],['File identifier',item.fid],['Category',item.category || 'General'],['Version',item.version || 1]]){const dl=node('dl',undefined,'col-12 col-sm-4 mb-0');dl.append(node('dt',label,'fw-normal text-body-secondary'),node('dd',value,'mb-0 text-break'));meta.append(dl);}
  $('#preview').hidden = fileKind(item.name) === 'other';$('#preview').disabled = false;
  $('#preview-area').replaceChildren(node('p',fileKind(item.name) === 'other' ? 'Preview is available for PDF, raster images and text documents. Download this file to open it locally.' : 'Choose Preview to retrieve the file and verify its contents.'));
  feedback('#detail-feedback',verified.has(item.fid) ? 'Contents were verified during this session.' : 'This document has not been checked in this session.');showDialog('details-dialog');
}
async function loadHistory(item) {
  try {
    const response=await apiFetch('/api/documents/'+encodeURIComponent(item.documentId));const data=await response.json();
    if(!response.ok)throw Error(data.error);
    if(activeReceipt!==item)return;
    const list=$('#version-list');list.replaceChildren();
    for(const version of data.versions.slice().reverse()){
      const li=node('li',undefined,'list-group-item d-flex justify-content-between align-items-center gap-2 px-0');
      li.append(node('span',`Version ${version.version} · ${when(version.uploadedAt)}`));
      const button=node('button',version.fid===item.fid?'Viewing':'Open','btn btn-outline-primary btn-sm');button.disabled=version.fid===item.fid;
      button.onclick=()=>openDetails(validateReceipt(version));li.append(button);list.append(li);
    }
  }catch(error){if(activeReceipt===item)feedback('#detail-feedback',error.message,'error');}
}
async function changeDocument(action) {
  const item=activeReceipt;if(!item)return;
  for(const id of ['save-category','move-trash','restore-document'])$('#'+id).disabled=true;
  try {
    const response=await apiFetch('/api/documents/'+encodeURIComponent(item.documentId),{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action,revision:item.revision,category:$('#document-category').value})});
    const data=await response.json();if(!response.ok)throw Error(data.error);
    hideDialog('details-dialog');await refreshCatalogue(true);notice(action==='trash'?'Document moved to trash. Its versions remain stored.':action==='restore'?'Document restored with its version history.':'Document category updated.');
  }catch(error){feedback('#detail-feedback',error.message,'error');}
  finally{for(const id of ['save-category','move-trash','restore-document'])$('#'+id).disabled=false;}
}
$('#save-category').onclick=()=>changeDocument('category');$('#move-trash').onclick=()=>changeDocument('trash');$('#restore-document').onclick=()=>changeDocument('restore');
$('#new-version').onclick=()=>{
  revisionTarget=activeReceipt;hideDialog('details-dialog');$('#upload-title').textContent='Upload new version';$('#upload-category-row').hidden=true;selectFiles([]);showDialog('upload-dialog');
};
async function refreshActivity() {
  try {
    const response=await apiFetch('/api/activity',{signal:AbortSignal.timeout(7000)});if(!response.ok)return;
    const data=await response.json(),list=$('#activity-list');list.replaceChildren();$('#activity-empty').hidden=!!data.entries.length;
    for(const entry of data.entries){const li=node('li');li.append(node('strong',entry.action),node('span',entry.detail),node('time',when(entry.at)));list.append(li);}
  }catch{}
}
$('#preview').onclick = async () => {
  const item = activeReceipt, button = $('#preview');button.disabled = true;$('#details-dialog').focus();feedback('#detail-feedback','Retrieving and verifying preview…');
  try {
    const bytes = await retrieve(item);if(activeReceipt !== item || !$('#details-dialog').classList.contains('show'))return;
    const area = $('#preview-area');area.replaceChildren();releasePreview();
    const type = fileKind(item.name);
    if(type === 'text'){area.append(node('pre',new TextDecoder().decode(bytes)));}
    else if(type==='pdf') {
      const {previewPdf}=await import('/pdf-preview.mjs');
      if(activeReceipt!==item || !$('#details-dialog').classList.contains('show'))return;
      pdfPreview=previewPdf(bytes,area,()=>activeReceipt===item&&$('#details-dialog').classList.contains('show'));
      await pdfPreview.done;
    }
    else {const ext = item.name.split('.').pop().toLowerCase();const mime = ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',bmp:'image/bmp'})[ext];previewUrl = URL.createObjectURL(new Blob([bytes],{type:mime}));const view = node('img');view.src = previewUrl;view.alt = `Preview of ${item.name}`;area.append(view);}
    if(activeReceipt!==item || !$('#details-dialog').classList.contains('show'))return;
    feedback('#detail-feedback','Preview ready. File contents verified.');logActivity('Preview verified',item.name);
  } catch(e){if(activeReceipt === item){feedback('#detail-feedback',e.message,'error');logActivity('Preview failed',`${item.name}: ${e.message}`,'error');}}
  finally {button.disabled = false;if(activeReceipt === item && $('#details-dialog').classList.contains('show') && document.activeElement === $('#details-dialog'))button.focus();refreshStorage();}
};
$('#detail-download').onclick = () => downloadFile(activeReceipt,$('#detail-download'),true);
$('#copy-id').onclick = async () => {try{await navigator.clipboard.writeText(activeReceipt.fid);feedback('#detail-feedback','File identifier copied.');}catch{feedback('#detail-feedback','Copy the file identifier shown above. Clipboard access is unavailable.');}};
$('#details-dialog').addEventListener('hidden.bs.modal',()=>{activeReceipt=null;releasePreview();});
for(const button of document.querySelectorAll('[data-close]'))button.onclick = () => {if(button.dataset.close === 'upload-dialog' && busy)return;hideDialog(button.dataset.close);};
const modalFocus = new Map();
function showDialog(id) {const element = document.getElementById(id);modalFocus.set(id,document.activeElement);bootstrap.Modal.getOrCreateInstance(element).show();}
function hideDialog(id) {bootstrap.Modal.getInstance(document.getElementById(id))?.hide();}
for(const modal of document.querySelectorAll('.modal'))modal.addEventListener('hidden.bs.modal',()=>{const opener=modalFocus.get(modal.id);if(opener?.isConnected)opener.focus();else $('#upload-open').focus();modalFocus.delete(modal.id);});
function showUpload() {revisionTarget=null;$('#upload-title').textContent='Upload documents';$('#upload-category-row').hidden=false;selectFiles([]);showDialog('upload-dialog');}
$('#upload-open').onclick = $('#empty-upload').onclick = showUpload;
$('#guide-open').onclick = () => showDialog('guide-dialog');
function selectFiles(files) {
  if(busy)return;
  if (revisionTarget && files.length !== 1) {feedback('#upload-feedback','Choose one file for this document revision.','error');return;}
  if(files.length > 10){feedback('#upload-feedback','Choose no more than 10 files in one batch.','error');return;}
  selected = Array.from(files);$('#selection').replaceChildren();
  for(const file of selected){const li=node('li',undefined,'list-group-item d-flex justify-content-between gap-3 small px-0');li.append(node('span',file.name,'text-truncate'),node('span',size(file.size),'text-body-secondary text-nowrap'));$('#selection').append(li);}
  $('#send').disabled = !selected.length || !!recoveryReceipts.length;feedback('#upload-feedback',selected.length ? `${selected.length} file${selected.length===1?'':'s'} selected. Empty files and files above 5 MiB will be rejected.` : 'No files selected.');
}
$('#file').onchange = e => selectFiles(e.target.files);
const zone = $('#drop-zone');
for(const event of ['dragenter','dragover'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.add('dragging');});
for(const event of ['dragleave','drop'])zone.addEventListener(event,e=>{e.preventDefault();zone.classList.remove('dragging');});
zone.addEventListener('drop',e=>selectFiles(e.dataTransfer.files));
$('#upload-dialog').addEventListener('hide.bs.modal',e=>{if(busy)e.preventDefault();});
$('#upload').onsubmit = async event => {
  event.preventDefault();if(busy||!selected.length)return;
  if (!catalogueReady) {feedback('#upload-feedback','The shared catalogue is unavailable. Refresh it before uploading.','error');return;}
  busy = true;$('#send').disabled = true;$('#file').disabled = true;$('#upload-dialog').focus();
  const failures = [];let succeeded = 0;
  try {
    for(const [index,file] of selected.entries()) {
      feedback('#upload-feedback',`Uploading ${index+1} of ${selected.length}: ${file.name}`);
      try {
        if(!file.size || file.size > maxBytes)throw Error('Select a nonempty file no larger than 5 MiB.');
        const response = await apiFetch('/api/files',{method:'POST',headers:{'content-type':'application/octet-stream','x-file-name':encodeURIComponent(file.name),'x-file-type':file.type||'application/octet-stream','x-document-category':$('#upload-category').value,...(revisionTarget?{'x-document-id':revisionTarget.documentId,'x-document-revision':String(revisionTarget.revision)}:{})},body:file,signal:AbortSignal.timeout(20000)});
        const data = await response.json();
        if(!response.ok){
          if(data.recoveryReceipt){recoveryReceipts.push(validateReceipt(data.recoveryReceipt));$('#recovery-notice').hidden=false;}
          throw Error(data.error || 'Upload failed.');
        }
        succeeded++;logActivity('Document uploaded',file.name);
      } catch(e){failures.push({file,error:e.message});logActivity('Upload failed',`${file.name}: ${e.message}`,'error');}
    }
  } finally {busy=false;$('#file').disabled=false;await refreshCatalogue(true);refreshStorage();}
  const attempted = selected.length;
  selectFiles(failures.map(x=>x.file));
  if(failures.length){feedback('#upload-feedback',`${succeeded} of ${attempted} uploaded. ${failures.map(x=>`${x.file.name}: ${x.error}`).join(' ')}`,'error');notice(`${succeeded} uploaded; ${failures.length} could not be uploaded. Review the selected files.`,'warn');}
  else {$('#file').value='';hideDialog('upload-dialog');notice(`${succeeded} document${succeeded===1?'':'s'} uploaded. Ready to retrieve and verify.`);}
};
$('#export-recovery').onclick = () => {
  saveBlob(new Blob([JSON.stringify({format:'dodc-document-receipts',version:1,receipts:recoveryReceipts},null,2)],{type:'application/json'}),'unconfirmed-upload-receipts.json');
};
$('#recover-uploads').onclick = async () => {
  const button=$('#recover-uploads');button.disabled=true;
  try {await importToCatalogue(recoveryReceipts);selected=selected.filter(x=>!recoveryReceipts.some(r=>r.name===x.name));recoveryReceipts=[];$('#recovery-notice').hidden=true;selectFiles(selected);notice('Unconfirmed uploads were verified and recovered into the catalogue.');}
  catch(error){notice(error.message,'error');}
  finally {button.disabled=false;}
};
$('#export').onclick = () => {saveBlob(new Blob([JSON.stringify({format:'dodc-document-receipts',version:1,exportedAt:new Date().toISOString(),receipts},null,2)],{type:'application/json'}),'document-receipts.json');notice('Receipts exported. This file contains retrieval details, not the stored documents.');logActivity('Receipts exported',`${receipts.length} retrieval receipts; no document contents`);};
$('#import-open').onclick = () => $('#import-file').click();
$('#import-file').onchange = async event => {
  const file=event.target.files[0];if(!file)return;
  try {
    if(file.size > 1024*1024)throw Error('Receipt imports must be below 1 MiB.');
    const data=JSON.parse(await file.text());
    if(data.format !== 'dodc-document-receipts' || data.version !== 1 || !Array.isArray(data.receipts) || data.receipts.length > 1000)throw Error('Choose a valid receipt export from this lab.');
    const incoming=data.receipts.map(validateReceipt);
    const result=await importToCatalogue(incoming);
    logActivity('Receipts imported',`${result.added} added after stored-content verification`);
    notice(`${result.added} documents imported to the shared catalogue. Existing documents were retained.`);
  } catch(e){logActivity('Receipt import rejected',e instanceof SyntaxError?'Invalid JSON':e.message,'error');notice(e instanceof SyntaxError ? 'The receipt file is not valid JSON. Nothing was imported.' : e.message,'error');}
  finally{event.target.value='';}
};
$('#catalogue-state-filter').onchange=()=>refreshCatalogue();
for(const input of ['#search','#type-filter','#sort','#category-filter'])$(input).addEventListener(input==='#search'?'input':'change',render);
let refreshing = false;
async function refreshStorage() {
  if(!currentUser)return;
  if(refreshing)return;refreshing = true;$('#refresh-storage').disabled = $('#overview-refresh').disabled = true;
  try {
    const response = await apiFetch('/api/storage-status',{signal:AbortSignal.timeout(7000)});const data=await response.json();
    if(!response.ok || !data.coordinatorReachable)throw Error('The storage coordinator could not be reached.');
    const count=data.services.filter(x=>x.registered&&x.reachable).length,copies=data.requestedCopies;
    $('#storage-label').textContent=count>=copies?'Storage connected':count===1?'Limited storage':'Storage unavailable';$('#storage-chip').dataset.tone=count>=copies?'success':count===1?'warn':'error';$('#storage-chip').className='btn btn-sm';
    renderStorageOverview(data);
    $('#replication-policy-label').textContent=`${data.replication} requests ${copies} ${copies===1?'copy':'copies'}. Placement depends on the configured data-centre, rack and service labels.`;
    $('#storage-summary').textContent=`${count} reachable registered service${count===1?'':'s'}. ${count>=copies?`${copies}-copy placement can be evaluated with an upload.`:count===1?`An existing copy may still serve reads; ${copies}-copy writes may be blocked.`:'Restore the storage services to retrieve or upload files.'}`;
    $('#storage-nodes').replaceChildren();
    for(const service of data.services){
      const available=service.registered&&service.reachable, row=node('tr');
      const name=node('td');name.append(node('code',service.name));row.append(name);
      row.append(node('td',service.registered?service.volumeCopies:'—'),node('td',service.registered?service.maxVolumeSlots:'—'));
      const status=node('td');status.append(node('span',available?'Reachable':service.registered?'Not reachable':'Not registered',`badge text-bg-${available?'success':service.registered?'danger':'secondary'}`));row.append(status);$('#storage-nodes').append(row);
    }
    $('#storage-checked').textContent=`Observed ${new Date(data.observedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  } catch(e){renderStorageOverview(null);$('#storage-label').textContent='Status unavailable';$('#storage-chip').dataset.tone='error';$('#storage-chip').className='btn btn-sm';$('#storage-summary').textContent='Could not observe storage status. Retry after the application and coordinator are running.';$('#storage-nodes').replaceChildren();$('#storage-checked').textContent='No current observation';}
  finally{refreshing=false;$('#refresh-storage').disabled=$('#overview-refresh').disabled=false;}
}
function setView(view) {
  const isStorage=view==='storage';
  $('#library').hidden=isStorage;$('#storage').hidden=!isStorage;
  $('#view-context').textContent=`Local workspace / ${isStorage?'Storage':'Documents'}`;
  for(const [id,active] of [['documents-nav',!isStorage&&!['#activity','#experiments'].includes(location.hash)],['storage-nav',isStorage],['activity-nav',!isStorage&&location.hash==='#activity'],['experiments-nav',!isStorage&&location.hash==='#experiments']]){const link=$('#'+id);link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  if(isStorage)refreshStorage();
}
function navigate(view){if(location.hash!==(view==='storage'?'#storage':'#library'))location.hash=view==='storage'?'storage':'library';else setView(view);}
window.addEventListener('hashchange',()=>setView(location.hash==='#storage'?'storage':'library'));
for(const [id,view] of [['documents-nav','library'],['storage-nav','storage'],['activity-nav','library'],['experiments-nav','library']])$('#'+id).onclick=()=>{
  setView(view);if(innerWidth<768)bootstrap.Collapse.getInstance($('#main-nav'))?.hide();
};
$('#overview-refresh').onclick=$('#refresh-storage').onclick=refreshStorage;
$('#open-storage').onclick=$('#storage-experiment').onclick=()=>navigate('storage');
$('#infrastructure-notes').onclick=()=>showDialog('guide-dialog');$('#storage-chip').onclick=()=>navigate('storage');
setView(location.hash==='#storage'?'storage':'library');
render();checkSession();setInterval(()=>{if(currentUser&&!document.hidden){refreshStorage();if(!busy)refreshCatalogue(true);}},15000);
async function apiFetch(url,options) {
  const response=await fetch(url,options);
  if(response.status===401)lockWorkspace('Your session ended. Sign in to continue.');
  return response;
}
function lockWorkspace(message='Sign in with a local lab account.') {
  currentUser=null;catalogueReady=false;receipts=[];verified.clear();activities.length=0;
  $('#files').replaceChildren();$('#activity-list').replaceChildren();releasePreview();
  for(const modal of document.querySelectorAll('.modal.show'))bootstrap.Modal.getInstance(modal)?.hide();
  $('#app-shell').hidden=true;$('#sign-in-panel').hidden=false;
  $('#account-label').hidden=$('#sign-out').hidden=$('#storage-chip').hidden=true;
  feedback('#sign-in-feedback',message);render();
}
async function enterWorkspace(user) {
  currentUser=user;$('#sign-in-panel').hidden=true;$('#app-shell').hidden=false;
  $('#account-label').textContent=`${user.username} · ${user.role==='editor'?'Editor':'Viewer'}`;
  $('#account-label').hidden=$('#sign-out').hidden=$('#storage-chip').hidden=false;
  $('#password').value='';await refreshCatalogue(true);refreshStorage();
}
async function checkSession() {
  try {
    const response=await fetch('/api/auth/session',{signal:AbortSignal.timeout(7000)}),data=await response.json();
    if(!response.ok)throw Error(data.error);
    if(data.user)await enterWorkspace(data.user);else lockWorkspace();
  }catch(error){lockWorkspace(error.message);}
}
$('#sign-in').onsubmit=async event=>{
  event.preventDefault();$('#sign-in-submit').disabled=true;feedback('#sign-in-feedback','Signing in…');
  try {
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:$('#username').value.trim(),password:$('#password').value}),signal:AbortSignal.timeout(10000)}),data=await response.json();
    if(!response.ok)throw Error(data.error);await enterWorkspace(data.user);
  }catch(error){feedback('#sign-in-feedback',error.message,'error');}
  finally{$('#sign-in-submit').disabled=false;}
};
$('#sign-out').onclick=async()=>{
  $('#sign-out').disabled=true;
  try {
    const response=await fetch('/api/auth/logout',{method:'POST',signal:AbortSignal.timeout(7000)}),data=await response.json();
    if(!response.ok)throw Error(data.error);lockWorkspace('Signed out.');
  }catch(error){notice(error.message,'error');}
  finally{$('#sign-out').disabled=false;}
};
