import {openDatabase} from './database.mjs';

export class CatalogueError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}
export const categories = ['General', 'Invoices', 'Contracts', 'Internal'];
export function validateReceipt(item) {
  if (!item || typeof item !== 'object' || typeof item.fid !== 'string' || !/^\d+,[a-f0-9]+$/i.test(item.fid)
    || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160 || /[\x00-\x1f]/.test(item.name)
    || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 5 * 1024 * 1024
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)
    || typeof item.uploadedAt !== 'string' || !Number.isFinite(Date.parse(item.uploadedAt))) {
    throw new CatalogueError('The receipt list contains an invalid document. Nothing was imported.', 400);
  }
  return {fid: item.fid, name: item.name, bytes: item.bytes, sha256: item.sha256.toLowerCase(), uploadedAt: item.uploadedAt};
}
const publicDocument = row => ({...validateReceipt(row.versions.at(-1)), documentId: row._id, version: row.versions.length, revision: row.revision, category: row.category, deletedAt: row.deletedAt, updatedAt: row.updatedAt});
const revisionNumber = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw new CatalogueError('A current document revision is required. Refresh documents and retry.', 400);
  return value;
};
export function createCatalogue(uri = process.env.MONGO_URL) {
  if (!uri) throw new Error('MONGO_URL is required for the shared catalogue.');
  const {client,db}=openDatabase(uri);
  const files = db.collection('receipts'), documents = db.collection('documents'), events = db.collection('activity');
  let preparation;
  async function ready() {
    try { await client.connect(); await db.command({ping: 1}); }
    catch { throw new CatalogueError('The document catalogue is unavailable. Restore the database and retry.'); }
  }
  const transaction = async fn => {
    const session = client.startSession();
    try {return await session.withTransaction(()=>fn(session), {readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:5000,timeoutMS:15000});}
    finally {await session.endSession();}
  };
  const newDocument = (receipt, category='General') => ({_id:receipt.fid, category, revision:1, deletedAt:null, createdAt:receipt.uploadedAt, updatedAt:receipt.uploadedAt, versions:[validateReceipt(receipt)]});
  async function prepare() {
    await ready();
    if (!preparation) preparation = (async()=>{
      const older = await files.find({documentId:{$exists:false}}).toArray();
      for (const row of older) await transaction(async session=>{
        await documents.updateOne({_id:row.fid},{$setOnInsert:newDocument(row)},{session,upsert:true});
        await files.updateOne({_id:row.fid},{$set:{documentId:row.fid}},{session});
      });
    })().catch(error=>{preparation=undefined;throw error;});
    await preparation;
  }
  const event = (session, action, document, detail) => events.insertOne({action,documentId:document._id,detail,at:new Date().toISOString()},{session});
  async function getDocument(id, session) {
    if (typeof id!=='string' || !/^\d+,[a-f0-9]+$/i.test(id)) throw new CatalogueError('Invalid document identifier.',400);
    const row=await documents.findOne({_id:id},{session});
    if(!row)throw new CatalogueError('Document not found.',404);return row;
  }
  return {
    database: db,
    connect: () => client.connect(),
    ready,
    close: () => client.close(),
    async list(state='active') {
      await prepare();
      return (await documents.find(state==='trash'?{deletedAt:{$ne:null}}:{deletedAt:null}).sort({updatedAt:-1}).toArray()).map(publicDocument);
    },
    async history(id) {
      await prepare();const row=await getDocument(id);
      return {...publicDocument(row),versions:row.versions.map((r,index)=>({...validateReceipt(r),version:index+1,documentId:row._id,revision:row.revision,category:row.category,deletedAt:row.deletedAt}))};
    },
    async preflight(id, revision) {
      await prepare();
      if(id){const row=await getDocument(id);if(row.deletedAt || row.revision!==revisionNumber(revision))throw new CatalogueError('This document changed or is in trash. Refresh it before uploading a revision.',409);}
    },
    async publish(receipt, {documentId, revision, category='General'}={}) {
      if(!categories.includes(category))throw new CatalogueError('Choose a valid category.',400);
      await prepare();
      return transaction(async session=>{
        let row;
        if(documentId){
          row=await getDocument(documentId,session);
          if(row.deletedAt || row.revision!==revisionNumber(revision))throw new CatalogueError('This document changed before the revision could be committed. Recover the stored file as a separate document, then review the latest version.',409);
          const result=await documents.updateOne({_id:documentId,revision:row.revision,deletedAt:null},{$push:{versions:validateReceipt(receipt)},$inc:{revision:1},$set:{updatedAt:receipt.uploadedAt}},{session});
          if(result.matchedCount!==1)throw new CatalogueError('This document changed. Refresh and retry.',409);
          row={...row,versions:[...row.versions,validateReceipt(receipt)],revision:row.revision+1,updatedAt:receipt.uploadedAt};
        }else{row=newDocument(receipt,category);await documents.insertOne(row,{session});}
        await files.insertOne({_id:receipt.fid,...validateReceipt(receipt),documentId:row._id,cataloguedAt:new Date().toISOString()},{session});
        await event(session,documentId?'Version uploaded':'Document uploaded',row,receipt.name);
        return publicDocument(row);
      });
    },
    async change(id, revision, change) {
      await prepare();revisionNumber(revision);
      if(!['category','trash','restore'].includes(change.action))throw new CatalogueError('Invalid document action.',400);
      if(change.action==='category' && !categories.includes(change.category))throw new CatalogueError('Choose a valid category.',400);
      return transaction(async session=>{
        const row=await getDocument(id,session);
        if(row.revision!==revision)throw new CatalogueError('Another request changed this document. Refresh its details and retry.',409);
        if((change.action==='restore') !== !!row.deletedAt)throw new CatalogueError(change.action==='restore'?'The document is already active.':'Restore this document before changing it.',409);
        const update=change.action==='category'?{category:change.category}:change.action==='trash'?{deletedAt:new Date().toISOString()}:{deletedAt:null};
        const updated={...row,...update,revision:revision+1,updatedAt:new Date().toISOString()};
        await documents.updateOne({_id:id,revision},{$set:{...update,updatedAt:updated.updatedAt},$inc:{revision:1}},{session});
        await event(session,change.action==='category'?'Category changed':change.action==='trash'?'Moved to trash':'Document restored',updated,change.action==='category'?`${row.versions.at(-1).name}: ${change.category}`:row.versions.at(-1).name);
        return publicDocument(updated);
      });
    },
    async activity() {await ready();return events.find({}, {projection:{_id:0}}).sort({at:-1}).limit(8).toArray();},
    async recordRead(fid) {
      const row=await files.findOne({_id:fid});
      if(row)await events.insertOne({action:'Contents retrieved',documentId:row.documentId,detail:row.name,at:new Date().toISOString()});
    },
    async receipt(fid) {await prepare();const row=await files.findOne({_id:fid});return row?validateReceipt(row):null;},
    async importReceipts(input, verify) {
      if(!Array.isArray(input)||input.length>1000)throw new CatalogueError('Import up to 1000 valid retrieval receipts.',400);
      const incoming=new Map();
      for(const value of input){const item=validateReceipt(value),previous=incoming.get(item.fid);if(previous&&(previous.sha256!==item.sha256||previous.bytes!==item.bytes))throw new CatalogueError('An identifier has conflicting hashes or sizes. Nothing was imported.',409);if(!previous)incoming.set(item.fid,item);}
      await prepare();
      for(const item of incoming.values())await verify(item);
      return transaction(async session=>{
        const existing=await files.find({_id:{$in:[...incoming.keys()]}},{session,batchSize:1000}).toArray(),byId=new Map(existing.map(x=>[x._id,x]));let added=0;
        for(const item of incoming.values()){
          const previous=byId.get(item.fid);
          if(previous&&(previous.sha256!==item.sha256||previous.bytes!==item.bytes))throw new CatalogueError('An identifier conflicts with the catalogue. Nothing was imported.',409);
          if(!previous){const row=newDocument(item);await documents.insertOne(row,{session});await files.insertOne({_id:item.fid,...item,documentId:item.fid,cataloguedAt:new Date().toISOString(),source:'verified-receipt-import'},{session});await event(session,'Receipt imported',row,item.name);added++;}
        }
        return {added,existing:incoming.size-added};
      });
    }
  };
}
