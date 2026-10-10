import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MAX_PORTFOLIO_BYTES, PortfolioError, authorizePortfolio, validatePortfolioPdf,
  parseTags,parseProjectIds,projectInput,rankPortfolios,createPortfolioStore
} from "../../src/lib/portfolio-cloud.mjs";

const fakePdf=Buffer.from("%PDF-1.7\n".padEnd(550,"x")+"\n%%EOF\n");
const env={CAREER_OPS_WEB_AUTH_USER:"candidate",CAREER_OPS_WEB_AUTH_PASSWORD:"secret-"+("x".repeat(48))};
const basic=(password=env.CAREER_OPS_WEB_AUTH_PASSWORD)=>
  "Basic "+Buffer.from(env.CAREER_OPS_WEB_AUTH_USER+":"+password).toString("base64");
const authorized=(method="GET",auth=basic(),origin=null)=>{
  const headers={authorization:auth};
  if(origin) headers.origin=origin;
  return new Request("https://career-ops-aselekoglu.vercel.app/api/portfolio",{method,headers});
};

test("reuses existing Career Ops site Basic Auth and denies wrong or missing login",()=>{
  assert.throws(()=>authorizePortfolio(authorized(),{}),{message:"PORTFOLIO_AUTH_NOT_CONFIGURED"});
  assert.throws(()=>authorizePortfolio(authorized("GET",basic("wrong")),env),{message:"PORTFOLIO_UNAUTHORIZED"});
  assert.throws(()=>authorizePortfolio(authorized("GET","none"),env),{message:"PORTFOLIO_UNAUTHORIZED"});
  assert.doesNotThrow(()=>authorizePortfolio(authorized(),env));
});
test("rejects cross-origin writes even with ambient Basic credentials",()=>{
  assert.throws(()=>authorizePortfolio(authorized("POST",basic(),"https://attacker.example"),env),{message:"PORTFOLIO_CROSS_ORIGIN"});
  assert.doesNotThrow(()=>authorizePortfolio(authorized("POST",basic(),"https://career-ops-aselekoglu.vercel.app"),env));
});

test("checks PDF header EOF size and sha256",()=>{
  assert.equal(validatePortfolioPdf(fakePdf).byteSize,fakePdf.length);
  assert.match(validatePortfolioPdf(fakePdf).sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>validatePortfolioPdf(Buffer.from("not a pdf")),PortfolioError);
  assert.throws(()=>validatePortfolioPdf(Buffer.from("%PDF-1.4\n".padEnd(600,"x"))),PortfolioError);
  assert.throws(()=>validatePortfolioPdf(Buffer.alloc(MAX_PORTFOLIO_BYTES+1)),PortfolioError);
});
test("bounds tags, project IDs and HTTPS links",()=>{
  assert.deepEqual(parseTags(["AI","ai","Engineering"]),["ai","engineering"]);
  assert.throws(()=>parseTags(["bad\nheader"]),PortfolioError);
  assert.throws(()=>parseTags(new Array(17).fill("a")),PortfolioError);
  assert.throws(()=>parseProjectIds(["../../.env"]),PortfolioError);
  const id=randomUUID();assert.deepEqual(parseProjectIds([id,id]),[id]);
  assert.throws(()=>projectInput({name:"X",summary:"S",url:"javascript:alert(1)"}),PortfolioError);
  assert.throws(()=>projectInput({name:"X",summary:"S",url:"https://user:pass@example.com/path"}),PortfolioError);
  assert.equal(projectInput({name:"GitHub",summary:"Reviewed technical integration",url:"https://github.com/example/repo",tags:["API"]}).url,"https://github.com/example/repo");
});
test("rankings are deterministic and do not auto-link anything",()=>{
  const r=rankPortfolios([
    {id:"a",title:"Software Developer Portfolio",kind:"master",tags:["React"],latestVersion:1},
    {id:"b",title:"Business Analyst Portfolio",kind:"variant",tags:["systems integration"],latestVersion:2}
  ],"Business Analyst Operational Strategy");
  assert.equal(r[0].portfolioId,"b");
  assert.ok(r[0].score>0);
  assert.equal(r[0].latestVersion,2);
});
test("queries use existing career_ops_documents store and archive immutable versions",async()=>{
  const calls=[];
  const sql={query:async(q,args)=>{calls.push([q,args]);if(q.startsWith("WITH p AS"))return [{version:q.includes("INSERT INTO career_ops_portfolios")?1:2}];return [];}};
  const store=createPortfolioStore(sql);
  const one=await store.upload({title:"Master",kind:"master",tags:["analytics"],projectIds:[]},fakePdf);
  assert.equal(one.version,1);
  assert.ok(calls.some(([query])=>query.includes("INSERT INTO career_ops_documents(path,content,sha256,content_encoding,byte_size,updated_at)")));
  const result=await store.upload({portfolioId:one.portfolioId},fakePdf);
  assert.equal(result.version,2);
  assert.equal(result.portfolioId,one.portfolioId);
  assert.ok(calls.some(([query])=>query.includes("FOR UPDATE")));
  assert.ok(calls.filter(([query])=>query.includes("INSERT INTO career_ops_documents")).every(([,args])=>args[5].startsWith("portfolios/")));
});
test("application association checks exact numeric tracker ID first",async()=>{
  const id=randomUUID();
  const calls=[];
  const sql={query:async(q,args)=>{calls.push([q,args]);if(q.includes("INSERT INTO career_ops_portfolio_applications"))return [{version:1}];return [];}};
  const store=createPortfolioStore(sql);
  await assert.rejects(()=>store.associate("54",id,1,async()=>false),{message:"PORTFOLIO_APPLICATION_NOT_FOUND"});
  assert.equal(calls.some(([q])=>q.includes("INSERT INTO career_ops_portfolio_applications")),false);
  const linked=await store.associate("54",id,1,async n=>n==="54");
  assert.equal(linked.applicationNumber,"54");
  assert.equal(linked.portfolioId,id);
});
test("missing PDF versions do not silently return an unrelated artifact",async()=>{
  const sql={query:async()=>[]};
  const store=createPortfolioStore(sql);
  await assert.rejects(()=>store.download(randomUUID(),1),{message:"PORTFOLIO_NOT_FOUND"});
});
