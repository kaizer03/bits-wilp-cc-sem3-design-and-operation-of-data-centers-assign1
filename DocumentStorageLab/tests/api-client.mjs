export async function waitReady(base) {
  for(let n=0;n<60;n++) {
    try {if((await fetch(base+'/api/ready',{signal:AbortSignal.timeout(4000)})).status===200)return;}catch{}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error('Assignment test API did not become ready.');
}
export async function createApi(base,role='editor') {
  await waitReady(base);
  let cookie;
  const request=async(url,options={})=>fetch(base+url,{...options,headers:{...(cookie?{cookie}:{}),...(!['GET','HEAD'].includes(options.method||'GET')?{origin:base}:{}),...options.headers},signal:options.signal||AbortSignal.timeout(20000)});
  const response=await request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:role,password:role+'-lab-2026'})});
  if(response.status!==200)throw Error('Test account login failed: '+response.status);
  cookie=response.headers.get('set-cookie').split(';')[0];
  return {request,json:async(url,options)=>{const r=await request(url,options);return {status:r.status,data:await r.json()};}};
}
