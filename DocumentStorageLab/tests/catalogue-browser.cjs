const {login}=require('./browser-login.cjs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),base='http://127.0.0.1:18390';
const run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','catalogue-browser-'+run);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const checks=[],errors=[];
const dc=(...args)=>execFileSync('docker',['compose','-p','dodc-document-lab-test','-f',path.join(root,'compose.yaml'),'-f',path.join(root,'tests/compose.test.yaml'),...args],{encoding:'utf8',env:{...process.env,LAB_HTTP_PORT:'18390'},timeout:60000});
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const a=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Kolkata'}),b=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await a.newPage(),other=await b.newPage();for(const p of [page,other])p.on('pageerror',e=>errors.push(e.message));
 const record=name=>{checks.push({name,pass:true});console.log('PASS',name);};
 try{
  await login(page,base);
  const name='browser-'+run+'.txt';
  await page.locator('#upload-open').click();await page.locator('#file').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from('Shared catalogue browser test\n')});await page.locator('#send').click();await page.locator('#upload-dialog').waitFor({state:'hidden'});
  await login(other,base);await other.locator('#files tr').filter({hasText:name}).waitFor();record('A clean browser sees another browser\'s upload without receipt import');
  const row=other.locator('#files tr').filter({hasText:name});await row.getByRole('button',{name:'View details'}).click();await other.locator('#preview').click();await other.locator('#detail-feedback').filter({hasText:'Preview ready'}).waitFor();assert.match(await other.locator('#preview-area pre').textContent(),/Shared catalogue browser test/);await other.keyboard.press('Escape');record('Shared document has a verified text preview');
  const event=other.waitForEvent('download');await row.getByRole('button',{name:'Download',exact:true}).click();const downloaded=await event;await downloaded.saveAs(path.join(out,'download.txt'));assert.equal(hash(await fs.readFile(path.join(out,'download.txt'))),hash(Buffer.from('Shared catalogue browser test\n')));record('Cross-browser download matches original bytes');
  const raw=Buffer.from('Older browser receipt migration\n'),legacyName='older-'+run+'.txt';
  const script=`const a=await (await fetch('http://master:9333/dir/assign?replication=001')).json();const f=new FormData();f.append('file',new Blob([Buffer.from('${raw.toString('base64')}','base64')]),'${legacyName}');await fetch('http://'+a.url+'/'+a.fid,{method:'POST',body:f});console.log(JSON.stringify({fid:a.fid}));`;
  const legacy={...JSON.parse(dc('exec','-T','api','node','--input-type=module','-e',script)),name:legacyName,bytes:raw.length,sha256:hash(raw),uploadedAt:new Date().toISOString()};
  await page.evaluate(x=>localStorage.setItem('dodc-lab-receipts-v1',JSON.stringify([x])),legacy);await page.reload();await page.locator('#migration-notice').waitFor();await page.locator('#migrate-legacy').click();await page.locator('#files tr').filter({hasText:legacyName}).waitFor();assert.deepEqual(JSON.parse(await page.evaluate(()=>localStorage.getItem('dodc-lab-receipts-v1'))),[legacy]);record('Verified legacy migration preserves the original browser receipt key');
  await other.locator('#catalogue-refresh').click();await other.locator('#files tr').filter({hasText:legacyName}).waitFor();record('Migrated documents become visible in another browser');
  dc('exec','-T','catalogue','mongosh','--quiet','--eval',"db.getSiblingDB('admin').auth('labAdmin',require('fs').readFileSync('/run/secrets/mongo_admin_password','utf8').trim());db.adminCommand({configureFailPoint:'failCommand',mode:{times:1},data:{failCommands:['insert'],errorCode:9}})");
  await page.locator('#upload-open').click();await page.locator('#file').setInputFiles({name:'uncertain-'+run+'.txt',mimeType:'text/plain',buffer:Buffer.from('Recover without reuploading bytes\n')});await page.locator('#send').click();await page.locator('#recovery-notice').waitFor();await page.locator('#send').filter({hasNotText:'unused'}).waitFor();assert.ok(await page.locator('#send').isDisabled());await page.locator('[data-close="upload-dialog"]').first().click();await page.locator('#upload-dialog').waitFor({state:'hidden'});await page.screenshot({path:path.join(out,'uncertain-upload.png'),fullPage:true});
  const exportEvent=page.waitForEvent('download');await page.locator('#export-recovery').click();const recovery=await exportEvent;await recovery.saveAs(path.join(out,'recovery-receipts.json'));
  await page.locator('#recover-uploads').click();await page.locator('#recovery-notice').waitFor({state:'hidden'});await page.locator('#files tr').filter({hasText:'uncertain-'+run+'.txt'}).waitFor();record('Unconfirmed upload offers saved recovery receipts and verifies recovery without another upload');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('#files tr').filter({hasText:name}).getByRole('button',{name:'Download',exact:true}).isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});record('Shared catalogue and document actions fit the mobile viewport');
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true});
  const deployed={};for(const file of ['index.html','app.js','styles.css']){const r=await page.request.get(base+'/'+(file==='index.html'?'':file));const actual=hash(await r.body()),expected=hash(await fs.readFile(path.join(root,'app/public',file)));assert.equal(actual,expected);deployed[file]=actual;}record('Served frontend matches the current workspace sources');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({run,checks,pageErrors:errors,deployedSourceSHA256:deployed},null,2));console.log('EVIDENCE',out);
 }catch(error){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({checks,error:error.stack,pageErrors:errors},null,2));throw error;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
