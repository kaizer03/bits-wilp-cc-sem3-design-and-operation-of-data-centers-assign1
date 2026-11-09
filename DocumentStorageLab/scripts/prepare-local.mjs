import {randomBytes} from 'node:crypto';
import {mkdir, writeFile, chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'.local/secrets');
await mkdir(dir,{recursive:true,mode:0o700});
await chmod(dir,0o700);
for(const [name,bytes] of [['mongo_keyfile',512],['mongo_admin_password',32],['mongo_app_password',32]]) {
  try {await writeFile(path.join(dir,name),randomBytes(bytes).toString('base64')+'\n',{flag:'wx',mode:0o444});}
  catch(error) {if(error.code!=='EEXIST')throw error;}
}
console.log('Local database secrets prepared without replacing existing credentials.');
