// Runs in MongoDB's network namespace to use the localhost exception once.
// Existing data and users are retained. Application permissions are database-scoped.
const fs=require('fs');
const adminPassword=fs.readFileSync('/run/secrets/mongo_admin_password','utf8').trim();
const appPassword=fs.readFileSync('/run/secrets/mongo_app_password','utf8').trim();
const admin=db.getSiblingDB('admin');
for(let attempt=0;attempt<60;attempt++) {
  try {
    let authenticated=false;
    try {authenticated=!!admin.auth('labAdmin',adminPassword);}catch{}
    try {admin.runCommand({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'catalogue:27017'}]}});}catch(error){if(!['AlreadyInitialized','Unauthorized'].includes(error.codeName))throw error;}
    if(!admin.hello().isWritablePrimary){sleep(1000);continue;}
    if(!authenticated) {
      admin.createUser({user:'labAdmin',pwd:adminPassword,roles:[{role:'root',db:'admin'}]});
      if(!admin.auth('labAdmin',adminPassword))throw Error('Administrator authentication failed.');
    }
    const catalogue=db.getSiblingDB('dodc_documents');
    if(!catalogue.getUser('documentApp'))catalogue.createUser({user:'documentApp',pwd:appPassword,roles:[{role:'readWrite',db:'dodc_documents'}]});
    print('Replica set and database-scoped application account are ready.');quit(0);
  }catch(error){if(attempt===59){print('Database initialization failed: '+error.codeName);quit(1);}}
  sleep(1000);
}
quit(1);
