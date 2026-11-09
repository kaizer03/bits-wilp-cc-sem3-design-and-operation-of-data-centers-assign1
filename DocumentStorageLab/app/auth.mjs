import {randomBytes,createHash,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback),cookieName='dodc_session',lifetime=8*60*60*1000;
const digest=value=>createHash('sha256').update(value).digest('hex');
export class AccessError extends Error {
  constructor(message,status=401){super(message);this.status=status;}
}
export function createAccess(db,connect=async()=>{}) {
  const users=db.collection('users'),sessions=db.collection('sessions'),attempts=db.collection('loginAttempts');
  let preparation;
  async function prepare() {
    await connect();
    if(!preparation) preparation=(async()=>{
      await sessions.createIndex({expiresAt:1},{expireAfterSeconds:0});
      await attempts.createIndex({expiresAt:1},{expireAfterSeconds:0});
      // Synthetic, explicitly documented lab accounts. No real employee information.
      for(const role of ['viewer','editor']) {
        const salt=randomBytes(16).toString('hex');
        const hash=Buffer.from(await scrypt(`${role}-lab-2026`,salt,64)).toString('hex');
        await users.updateOne({_id:role},{$setOnInsert:{role,salt,hash}},{upsert:true});
      }
    })().catch(error=>{preparation=undefined;throw error;});
    await preparation;
  }
  const setCookie=(res,token,maxAge=lifetime)=>res.cookie(cookieName,token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge});
  function token(req) {
    const value=(req.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    return value && /^[a-f0-9]{64}$/.test(value)?value:null;
  }
  function sameOrigin(req) {
    const origin=req.get('origin');
    if(!origin || !['http://'+req.get('host'),'https://'+req.get('host')].includes(origin))throw new AccessError('This change requires a request from the lab workspace.',403);
    if(req.get('sec-fetch-site')==='cross-site')throw new AccessError('Cross-site requests are not accepted.',403);
  }
  async function identity(req) {
    const raw=token(req);if(!raw)return null;
    await prepare();
    const session=await sessions.findOne({_id:digest(raw),expiresAt:{$gt:new Date()}});
    if(!session)return null;
    const user=await users.findOne({_id:session.username});
    return user?{username:user._id,role:user.role}:null;
  }
  return {
    prepare,sameOrigin,identity,
    async login(req,res) {
      sameOrigin(req);await prepare();
      const {username,password}=req.body||{};
      if(typeof username!=='string'||typeof password!=='string'||username.length>64||password.length>128)throw new AccessError('Enter a valid lab username and password.',400);
      // Shared ten-minute budget: requests to another API instance do not reset it.
      const key=digest(`${req.ip}|${username.toLowerCase()}`),now=Date.now();
      await attempts.deleteOne({_id:key,expiresAt:{$lte:new Date(now)}});
      const attempt=await attempts.findOneAndUpdate({_id:key},{$inc:{count:1},$setOnInsert:{expiresAt:new Date(now+10*60*1000)}},{upsert:true,returnDocument:'after'});
      if(attempt.count>15)throw new AccessError('Too many sign-in attempts. Retry after ten minutes.',429);
      const user=await users.findOne({_id:username});
      const actual=Buffer.from(await scrypt(password,user?.salt||'synthetic-invalid-user-salt',64));
      if(!user || !timingSafeEqual(actual,Buffer.from(user.hash,'hex')))throw new AccessError('Username or password is incorrect.');
      await attempts.deleteOne({_id:key});
      const previous=token(req);if(previous)await sessions.deleteOne({_id:digest(previous)});
      const raw=randomBytes(32).toString('hex');
      await sessions.insertOne({_id:digest(raw),username:user._id,createdAt:new Date(),expiresAt:new Date(now+lifetime)});
      setCookie(res,raw);return {username:user._id,role:user.role};
    },
    async logout(req,res) {
      sameOrigin(req);const raw=token(req);if(raw)await sessions.deleteOne({_id:digest(raw)});
      setCookie(res,'',0);
    },
    middleware: async(req,res,next)=>{
      try {
        if(!['GET','HEAD','OPTIONS'].includes(req.method))sameOrigin(req);
        const user=await identity(req);
        if(!user)throw new AccessError('Sign in to access the document workspace.');
        if(!['GET','HEAD','OPTIONS'].includes(req.method)&&user.role!=='editor')throw new AccessError('An editor account is required for this change.',403);
        req.user=user;next();
      }catch(error){res.status(error instanceof AccessError?error.status:503).json({error:error instanceof AccessError?error.message:'Access checks are unavailable. Restore the database and retry.'});}
    }
  };
}
