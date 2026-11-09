import {MongoClient} from 'mongodb';
import {readFileSync} from 'node:fs';
export function openDatabase(uri=process.env.MONGO_URL) {
  if(!uri)throw new Error('MONGO_URL is required.');
  const options={serverSelectionTimeoutMS:2000,connectTimeoutMS:2000,socketTimeoutMS:5000,maxPoolSize:10};
  if(process.env.MONGO_PASSWORD_FILE) options.auth={username:'documentApp',password:readFileSync(process.env.MONGO_PASSWORD_FILE,'utf8').trim()};
  const client=new MongoClient(uri,options);
  return {client,db:client.db('dodc_documents')};
}
