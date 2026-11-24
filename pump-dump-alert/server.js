require("dotenv").config();
const express=require("express"),http=require("http"),WebSocket=require("ws"),webpush=require("web-push"),fs=require("fs"),path=require("path");
const RSSParser=require("rss-parser");const rssParser=new RSSParser();let newsCache={at:0,items:[]};
const app=express(),server=http.createServer(app),PORT=Number(process.env.PORT||3000),PUB=path.join(__dirname,"public"),DATA=path.join(__dirname,"data"),SUBFILE=path.join(DATA,"subs.json");
app.use(express.json({limit:"100kb"}));app.use(express.static(PUB));
let subs=[];try{fs.mkdirSync(DATA,{recursive:true});if(fs.existsSync(SUBFILE))subs=JSON.parse(fs.readFileSync(SUBFILE,"utf8"))}catch(e){console.error(e.message)}
function saveSubs(){try{fs.mkdirSync(DATA,{recursive:true});fs.writeFileSync(SUBFILE,JSON.stringify(subs))}catch(e){console.error(e.message)}}
const vapid=!!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY);if(vapid)webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
const THRESHOLD=2,alerts=[];let sockets=[],symbols=0,lastAt=0,reconnect=null,stopping=false;const sent=new Set();
app.get("/api/status",(_q,r)=>r.json({connected:sockets.some(s=>s.readyState===WebSocket.OPEN),symbols,lastAt,telegram:!!(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID),browserPush:vapid}));
app.get("/api/config",(_q,r)=>r.json({vapidPublicKey:process.env.VAPID_PUBLIC_KEY||""}));app.get("/api/alerts",(_q,r)=>r.json(alerts));
app.post("/api/push/subscribe",(q,r)=>{const s=q.body;if(!s?.endpoint||!s?.keys?.p256dh||!s?.keys?.auth)return r.status(400).json({error:"Invalid subscription"});if(!subs.some(x=>x.endpoint===s.endpoint)){subs.push(s);saveSubs()}r.json({ok:true})});
async function telegram(text){const t=process.env.TELEGRAM_BOT_TOKEN,c=process.env.TELEGRAM_CHAT_ID;if(!t||!c)return;try{const r=await fetch("https://api.telegram.org/bot"+t+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:c,text})});if(!r.ok)console.error("Telegram:",r.status)}catch(e){console.error(e.message)}}
async function push(payload){if(!vapid)return;const dead=[];await Promise.all(subs.map(async s=>{try{await webpush.sendNotification(s,JSON.stringify(payload),{TTL:60})}catch(e){if([404,410].includes(e.statusCode))dead.push(s.endpoint);else console.error("push:",e.message)}}));if(dead.length){subs=subs.filter(s=>!dead.includes(s.endpoint));saveSubs()}}
function notify(symbol,pct,price,candle){const dir=pct>0?"PUMP":"DUMP",key=symbol+":"+dir+":"+candle;if(sent.has(key))return;sent.add(key);if(sent.size>12000)sent.clear();const sign=pct>0?"+":"",body=sign+pct.toFixed(2)+"% in current 1m candle · Price "+price,a={symbol,direction:dir,pct:+pct.toFixed(3),price,time:Date.now(),candle};alerts.unshift(a);alerts.splice(100);console.log("[ALERT]",symbol,body);telegram("🚨 "+dir+": "+symbol+"\n"+body+"\nMarket monitor only — not a trading signal.");push({title:dir+": "+symbol,body,url:"https://www.binance.com/en/futures/"+symbol,tag:key})}
async function start(){const res=await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");if(!res.ok)throw Error("Binance exchangeInfo HTTP "+res.status);const data=await res.json(),ss=data.symbols.filter(s=>s.status==="TRADING"&&s.quoteAsset==="USDT"&&s.contractType==="PERPETUAL"&&/^[A-Z0-9]+$/.test(s.symbol)).map(s=>s.symbol.toLowerCase());symbols=ss.length;sockets.forEach(s=>{try{s.close()}catch{}});sockets=[];for(let i=0;i<ss.length;i+=200){const names=ss.slice(i,i+200).map(s=>s+"@kline_1m"),ws=new WebSocket("wss://fstream.binance.com/stream?streams="+names.join("/"));sockets.push(ws);ws.on("open",()=>console.log("Binance stream open",names.length));ws.on("message",raw=>{lastAt=Date.now();try{const d=JSON.parse(raw.toString()).data,k=d?.k;if(!k||k.i!=="1m")return;const o=+k.o,c=+k.c;if(!o||!c)return;const pct=(c-o)/o*100;if(pct>=THRESHOLD||pct<=-THRESHOLD)notify(d.s,pct,k.c,k.t)}catch(e){console.error(e.message)}});ws.on("error",e=>console.error("WS:",e.message));ws.on("close",()=>{sockets=sockets.filter(x=>x!==ws);if(!stopping&&!reconnect)reconnect=setTimeout(()=>{reconnect=null;start().catch(e=>console.error(e.message))},5000)})}console.log("Monitoring",symbols,"USDT perpetual markets")}

const NEWS_FEEDS=[
  {name:"CoinDesk",url:"https://www.coindesk.com/arc/outboundfeeds/rss/"},
  {name:"Cointelegraph",url:"https://cointelegraph.com/rss"},
  {name:"CNBC Markets",url:"https://www.cnbc.com/id/100003114/device/rss/rss.html"},
  {name:"Wall Street Journal Markets",url:"https://feeds.a.dj.com/rss/RSSMarketsMain.xml"}
];
function classifyNews(title,description){
 const s=(title+" "+description).toLowerCase();
 let region="Global";if(/\b(federal reserve|fed |white house|u\.s\.|united states|sec |donald trump|treasury|congress|cftc|wall street|america|american)\b/.test(s))region="United States";
 else if(/\b(china|beijing|pbo c|people's bank of china|yuan|hong kong)\b/.test(s))region="China";
 else if(/\b(european union|europe|ecb|eurozone|france|germany|uk |britain|bank of england)\b/.test(s))region="Europe";
 else if(/\b(japan|boj|bank of japan|yen)\b/.test(s))region="Japan";
 else if(/\b(india|rbi|south korea|singapore|taiwan|asia)\b/.test(s))region="Asia";
 let impact="Medium";if(/rate decision|interest rate|inflation|cpi|jobs report|payroll|etf approval|sec approves|ban crypto|crypto ban|tariff|sanction|war |hack|exploit|liquidation|bitcoin reserve|bitcoin etf|fed chair|regulation|court ruling|stablecoin bill|default/.test(s))impact="High";
 const catalyst=/upcoming|to meet|will meet|expected to|due (on|to)|scheduled|next week|tomorrow|this week|on monday|on tuesday|on wednesday|on thursday|on friday|rate decision|cpi report|jobs report|earnings calendar|hearing|vote on|deadline|launch date|unlocks? on/.test(s);
 return {region,impact,catalyst};
}
app.get("/api/news",async(_q,r)=>{
 if(Date.now()-newsCache.at<300000&&newsCache.items.length)return r.json({updatedAt:newsCache.at,items:newsCache.items});
 const items=await Promise.all(NEWS_FEEDS.map(async feed=>{try{
   const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),9000);
   const response=await fetch(feed.url,{signal:ac.signal,headers:{"user-agent":"TradePulseNews/1.0 (market news reader)"} });clearTimeout(timer);
   if(!response.ok)throw Error("RSS HTTP "+response.status);
   const xml=await response.text(),parsed=await rssParser.parseString(xml);
   return (parsed.items||[]).slice(0,18).map(x=>{const title=(x.title||"").trim(),description=String(x.contentSnippet||x.summary||x.content||"").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,420),c=classifyNews(title,description);return {title,description,url:x.link||"",source:feed.name,publishedAt:x.isoDate||x.pubDate||null,...c}}).filter(x=>x.title&&x.url);
 }catch(e){console.error("News feed "+feed.name+":",e.message);return []}}));
 const unique=new Map();for(const x of items.flat())if(!unique.has(x.title.toLowerCase()))unique.set(x.title.toLowerCase(),x);
 const merged=[...unique.values()].sort((a,b)=>(Date.parse(b.publishedAt||"")||0)-(Date.parse(a.publishedAt||"")||0)).slice(0,60);
 newsCache={at:Date.now(),items:merged};r.json({updatedAt:newsCache.at,items:merged,feeds:NEWS_FEEDS.length});
});

app.get("*",(q,r,next)=>q.path.startsWith("/api/")?next():r.sendFile(path.join(PUB,"index.html")));
server.listen(PORT,()=>{console.log("Dashboard on",PORT);start().catch(e=>{console.error(e.message);setTimeout(()=>start().catch(console.error),10000)})});
process.on("SIGTERM",()=>{stopping=true;if(reconnect)clearTimeout(reconnect);sockets.forEach(s=>s.close());server.close(()=>process.exit(0))});