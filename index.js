
import express from "express";
import cors from "cors";
import session from "express-session";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { google } from "googleapis";
import { registerAgent } from "./agent-engine.js";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`;

const allowedOrigin = process.env.PUBLIC_ORIGIN || true;
app.set("trust proxy", 1);
app.use(cors({origin:allowedOrigin,credentials:true}));
app.use(express.json({limit:"10mb"}));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave:false, saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production"}
}));
app.use(express.static("public"));

const oauthScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];

function googleClient(){
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${ORIGIN}/auth/google/callback`
  );
}

function pkce(){
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return {verifier,challenge};
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"JARVIS Independent Agent",version:"114",agent:true,modelProvider:!!(process.env.AI_BASE_URL&&process.env.AI_API_KEY&&process.env.AI_MODEL)}));

app.get("/api/integrations/status",(req,res)=>res.json({
  gmail:!!req.session.googleTokens,
  canva:!!req.session.canvaTokens,
  whatsapp:!!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID),
  agent:true
}));

app.get("/auth/google",(req,res)=>{
  if(!process.env.GOOGLE_CLIENT_ID) return res.status(503).send("Google OAuth is not configured.");
  const client=googleClient();
  const url=client.generateAuthUrl({access_type:"offline",prompt:"consent",scope:oauthScopes});
  res.redirect(url);
});
app.get("/auth/google/callback",async(req,res)=>{
  try{
    const client=googleClient();
    const {tokens}=await client.getToken(req.query.code);
    req.session.googleTokens=tokens;
    res.send("<script>window.close();document.write('<h2>Gmail connected to JARVIS.</h2><p>You can close this tab.</p>')</script>");
  }catch(e){res.status(500).send(`Google OAuth failed: ${String(e.message||e)}`)}
});

function canvaConfig(){
  return {
    clientId:process.env.CANVA_CLIENT_ID,
    clientSecret:process.env.CANVA_CLIENT_SECRET,
    redirect:process.env.CANVA_REDIRECT_URI || `${ORIGIN}/auth/canva/callback`,
    scopes:process.env.CANVA_SCOPES || "design:content:write design:meta:read asset:read asset:write profile:read"
  };
}
app.get("/auth/canva",(req,res)=>{
  const c=canvaConfig();
  if(!c.clientId||!c.clientSecret) return res.status(503).send("Canva OAuth is not configured.");
  const {verifier,challenge}=pkce();
  const state=crypto.randomBytes(24).toString("base64url");
  req.session.canvaPKCE={verifier,state};
  const q=new URLSearchParams({
    code_challenge:challenge,code_challenge_method:"s256",
    scope:c.scopes,response_type:"code",client_id:c.clientId,
    state,redirect_uri:c.redirect
  });
  res.redirect("https://www.canva.com/api/oauth/authorize?"+q.toString());
});
app.get("/auth/canva/callback",async(req,res)=>{
  try{
    const c=canvaConfig(), p=req.session.canvaPKCE;
    if(!p || p.state!==req.query.state) return res.status(400).send("Invalid Canva OAuth state.");
    const basic=Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
    const body=new URLSearchParams({
      grant_type:"authorization_code",
      code:String(req.query.code),
      code_verifier:p.verifier,
      redirect_uri:c.redirect
    });
    const r=await fetch("https://api.canva.com/rest/v1/oauth/token",{
      method:"POST",
      headers:{"Authorization":`Basic ${basic}`,"Content-Type":"application/x-www-form-urlencoded"},
      body
    });
    const data=await r.json();
    if(!r.ok) throw new Error(data.message||"Canva token exchange failed");
    req.session.canvaTokens=data;
    delete req.session.canvaPKCE;
    res.send("<script>window.close();document.write('<h2>Canva connected to JARVIS.</h2><p>You can close this tab.</p>')</script>");
  }catch(e){res.status(500).send(`Canva OAuth failed: ${String(e.message||e)}`)}
});

app.get("/api/gmail/messages",async(req,res)=>{
  try{
    if(!req.session.googleTokens) return res.status(401).json({error:"Gmail not connected"});
    const auth=googleClient(); auth.setCredentials(req.session.googleTokens);
    const gmail=google.gmail({version:"v1",auth});
    const list=await gmail.users.messages.list({userId:"me",maxResults:20});
    const msgs=[];
    for(const m of (list.data.messages||[]).slice(0,10)){
      const x=await gmail.users.messages.get({userId:"me",id:m.id,format:"metadata",metadataHeaders:["Subject","From","Date"]});
      const h=x.data.payload?.headers||[];
      const get=n=>h.find(z=>z.name.toLowerCase()===n.toLowerCase())?.value||"";
      msgs.push({id:m.id,subject:get("Subject"),from:get("From"),date:get("Date"),snippet:x.data.snippet||""});
    }
    res.json({messages:msgs});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/gmail/send",async(req,res)=>{
  try{
    if(!req.session.googleTokens) return res.status(401).json({error:"Gmail not connected"});
    const {to,subject,body}=req.body||{};
    if(!to||!subject||!body) return res.status(400).json({error:"to, subject and body are required"});
    const auth=googleClient(); auth.setCredentials(req.session.googleTokens);
    const gmail=google.gmail({version:"v1",auth});
    const raw=[
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body
    ].join("\r\n");
    const encoded=Buffer.from(raw).toString("base64url");
    const sent=await gmail.users.messages.send({userId:"me",requestBody:{raw:encoded}});
    res.json({ok:true,id:sent.data.id});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/whatsapp/send",async(req,res)=>{
  try{
    const {to,text}=req.body||{};
    if(!process.env.WA_ACCESS_TOKEN||!process.env.WA_PHONE_NUMBER_ID) return res.status(503).json({error:"WhatsApp Business credentials are not configured"});
    if(!to||!text) return res.status(400).json({error:"to and text are required"});
    const version=process.env.WA_API_VERSION||"v23.0";
    const url=`https://graph.facebook.com/${version}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
    const r=await fetch(url,{
      method:"POST",
      headers:{"Authorization":`Bearer ${process.env.WA_ACCESS_TOKEN}`,"Content-Type":"application/json"},
      body:JSON.stringify({messaging_product:"whatsapp",to,type:"text",text:{body:text}})
    });
    const data=await r.json();
    if(!r.ok) return res.status(r.status).json({error:data.error?.message||"WhatsApp API error",details:data});
    res.json({ok:true,data});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/canva/create-design",async(req,res)=>{
  try{
    if(!req.session.canvaTokens) return res.status(401).json({error:"Canva not connected"});
    const {type="poster",width=1080,height=1350,title="JARVIS Poster"}=req.body||{};
    const r=await fetch("https://api.canva.com/rest/v1/designs",{
      method:"POST",
      headers:{"Authorization":`Bearer ${req.session.canvaTokens.access_token}`,"Content-Type":"application/json"},
      body:JSON.stringify({
        type:"type_and_asset",
        design_type:{type:"custom",width:Number(width),height:Number(height)},
        title:String(title).slice(0,255)
      })
    });
    const data=await r.json();
    if(!r.ok) return res.status(r.status).json({error:data.message||"Canva API error",details:data});
    res.json(data);
  }catch(e){res.status(500).json({error:e.message})}
});

/* Independent agent runtime. Safe local actions can execute automatically;
   external side effects remain approval-gated. */
const agentRuntime = registerAgent(app, {
  webSearch: async (q) => {
    if(!process.env.WEB_SEARCH_URL) return [];
    const url=new URL(process.env.WEB_SEARCH_URL); url.searchParams.set("q",q);
    const headers=process.env.WEB_SEARCH_KEY?{"Authorization":`Bearer ${process.env.WEB_SEARCH_KEY}`}:{};
    const r=await fetch(url,{headers}); const data=await r.json();
    return data.results||data.items||[];
  },
  weather: async (city) => {
    if(!process.env.WEATHER_API_URL) return {city,summary:"Weather adapter not configured."};
    const url=new URL(process.env.WEATHER_API_URL); url.searchParams.set("city",city);
    const r=await fetch(url); const data=await r.json();
    return {city,summary:data.summary||data.current||JSON.stringify(data)};
  },
  emailSend: async (input, req) => {
    if(!req.session.googleTokens) return {ok:false,error:"Gmail is not connected."};
    const auth=googleClient(); auth.setCredentials(req.session.googleTokens);
    const gmail=google.gmail({version:"v1",auth});
    const to=String(input?.to||"").trim(), subject=String(input?.subject||"JARVIS message").trim(), body=String(input?.body||input?.goal||"").trim();
    if(!to || !body) return {ok:false,error:"The agent needs a recipient and message body before sending email."};
    const raw=[`To: ${to}`,`Subject: ${subject}`,"Content-Type: text/plain; charset=utf-8","",body].join("\r\n");
    const sent=await gmail.users.messages.send({userId:"me",requestBody:{raw:Buffer.from(raw).toString("base64url")}});
    return {ok:true,id:sent.data.id};
  },
  whatsappSend: async (input) => {
    if(!process.env.WA_ACCESS_TOKEN||!process.env.WA_PHONE_NUMBER_ID) return {ok:false,error:"WhatsApp Business credentials are not configured."};
    const to=String(input?.to||"").trim(), text=String(input?.text||input?.goal||"").trim();
    if(!to||!text) return {ok:false,error:"The agent needs a recipient and message before sending WhatsApp."};
    const version=process.env.WA_API_VERSION||"v23.0";
    const r=await fetch(`https://graph.facebook.com/${version}/${process.env.WA_PHONE_NUMBER_ID}/messages`,{method:"POST",headers:{"Authorization":`Bearer ${process.env.WA_ACCESS_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",to,type:"text",text:{body:text}})});
    const data=await r.json();
    return r.ok?{ok:true,data}:{ok:false,error:data.error?.message||"WhatsApp API error"};
  },
  canvaCreate: async (input, req) => {
    if(!req.session.canvaTokens) return {ok:false,error:"Canva is not connected."};
    const title=String(input?.title||input?.goal||"JARVIS Design").slice(0,255);
    const r=await fetch("https://api.canva.com/rest/v1/designs",{method:"POST",headers:{"Authorization":`Bearer ${req.session.canvaTokens.access_token}`,"Content-Type":"application/json"},body:JSON.stringify({type:"type_and_asset",design_type:{type:"custom",width:1080,height:1350},title})});
    const data=await r.json();
    return r.ok?{ok:true,data}:{ok:false,error:data.message||"Canva API error"};
  }
});

app.get("/api/weather",async(req,res)=>{
  const city=String(req.query.city||"").trim();
  if(!city)return res.status(400).json({error:"city required"});
  try{
    if(!process.env.WEATHER_API_URL) return res.json({city,summary:"Weather adapter not configured. Add WEATHER_API_URL to the backend."});
    const url=new URL(process.env.WEATHER_API_URL); url.searchParams.set("city",city);
    const r=await fetch(url); const data=await r.json();
    res.json({city,summary:data.summary||data.current||JSON.stringify(data)});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/api/web/search",async(req,res)=>{
  const q=String(req.query.q||"").trim();
  if(!q)return res.status(400).json({error:"q required"});
  try{
    if(!process.env.WEB_SEARCH_URL) return res.json({results:[]});
    const url=new URL(process.env.WEB_SEARCH_URL); url.searchParams.set("q",q);
    const headers=process.env.WEB_SEARCH_KEY?{"Authorization":`Bearer ${process.env.WEB_SEARCH_KEY}`} : {};
    const r=await fetch(url,{headers}); const data=await r.json();
    res.json({results:data.results||data.items||[]});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get("/",(req,res)=>res.sendFile(process.cwd()+"/public/jarvis.html"));
app.listen(PORT,()=>console.log(`JARVIS Agent Bridge running at ${ORIGIN}`));
