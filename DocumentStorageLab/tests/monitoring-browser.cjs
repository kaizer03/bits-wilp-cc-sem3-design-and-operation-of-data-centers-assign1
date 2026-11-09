const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {login}=require('./browser-login.cjs');
const root=path.resolve(__dirname,'..'),run=new Date().toISOString().replace(/[:.]/g,'-'),out=path.join(root,'evidence','monitoring-browser-'+run),checks=[];
(async()=>{
 await fs.mkdir(out,{recursive:true});const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1700}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('http://127.0.0.1:19382/d/dodc-operations/document-service-operations',{waitUntil:'networkidle'});
  for(const title of ['API scrape availability','Dependency readiness','API requests per second','API response p95 (histogram estimate)','Server errors per second','Document payload bytes per second','API resident memory','API CPU cores used'])await page.getByText(title,{exact:true}).first().waitFor();
  assert.ok(await page.locator('canvas').count()+await page.locator('svg').count()>0);await page.screenshot({path:path.join(out,'grafana.png'),fullPage:true});
  await page.getByText('API CPU cores used',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'grafana-resources.png'),fullPage:true});assert.deepEqual(errors,[]);checks.push({name:'Eight provisioned dashboard panels load in a real browser without script errors',pass:true});
  await login(page,'http://127.0.0.1:18390');assert.match(await page.locator('#replication-overview').textContent(),/001.*2 copies/);await page.locator('#open-storage').click();assert.match(await page.locator('#replication-policy-label').textContent(),/001 requests 2 copies/);await page.screenshot({path:path.join(out,'storage-policy.png'),fullPage:true});checks.push({name:'Workspace displays the actual API replication policy and requested copy count',pass:true});
  await fs.writeFile(path.join(out,'checks.json'),JSON.stringify({run,checks,pageErrors:errors},null,2));console.log('EVIDENCE',out);
 }catch(e){await fs.writeFile(path.join(out,'failure.json'),JSON.stringify({checks,error:e.stack,pageErrors:errors},null,2));throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
