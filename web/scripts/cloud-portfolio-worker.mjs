#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {extractPdfTextFromFile} from '../../intake.mjs';
import {isMainModule} from '../../lib/is-main-module.mjs';

const CODE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const API='https://career-ops-aselekoglu.vercel.app/api/portfolio/worker';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function runProcess(command,args){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:CODE_ROOT,env:process.env,stdio:['ignore','ignore','ignore'],windowsHide:true});let settled=false;
  const timer=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}if(!settled){settled=true;reject(new Error('PORTFOLIO_RENDER_TIMEOUT'))}},8*60*1000);
  child.once('error',()=>{clearTimeout(timer);if(!settled){settled=true;reject(new Error('PORTFOLIO_RENDER_START_FAILED'))}});
  child.once('close',code=>{clearTimeout(timer);if(settled)return;settled=true;code===0?resolve():reject(new Error('PORTFOLIO_RENDER_FAILED'))});
})}
export async function renderPortfolioClaim(claim,{run=runProcess,root=CODE_ROOT}={}){
  if(!claim||!UUID.test(claim.runId||'')||!UUID.test(claim.lease||'')||claim.phase!=='render'||typeof claim.html!=='string'||!claim.html.includes('</html>')||!['letter','a4'].includes(claim.format)||claim.maxPages!==12)throw new Error('INVALID_PORTFOLIO_WORKER_CLAIM');
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'career-ops-portfolio-'));
  const input=path.join(temp,`${claim.runId}.html`),output=path.join(temp,`${claim.runId}.pdf`);
  try{
    await fs.writeFile(input,claim.html,'utf8');
    await run(process.execPath,[path.join(root,'generate-pdf.mjs'),input,output,`--format=${claim.format}`,'--allow-reorder','--max-pages=12','--strict-pages']);
    const pdf=await fs.readFile(output);if(pdf.length<500||pdf.length>3_000_000||pdf.subarray(0,5).toString('ascii')!=='%PDF-'||!pdf.subarray(-2048).toString('latin1').includes('%%EOF'))throw new Error('PORTFOLIO_RENDER_INVALID_PDF');
    return {pdfBase64:pdf.toString('base64'),byteSize:pdf.length};
  }finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{})}
}
export async function runCloudPortfolioWorker({id=process.env.PORTFOLIO_RUN_ID,secret=process.env.CAREER_OPS_SCAN_WORKER_SECRET,failOnly=false,fetchFn=fetch,extract=extractPdfTextFromFile,root=CODE_ROOT}={}){
  if(!UUID.test(id||'')||!secret)throw new Error('PORTFOLIO_WORKER_CONFIGURATION_INVALID');
  async function request(action,extra={},binary=false){
    const response=await fetchFn(API,{method:'POST',redirect:'error',signal:AbortSignal.timeout(300_000),headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({action,runId:id,...extra})});
    if(action==='claim'&&response.status===409)throw new Error('PORTFOLIO_RUN_NOT_CLAIMABLE');
    if(!response.ok)throw new Error('PORTFOLIO_WORKER_CALLBACK_FAILED');
    return binary?Buffer.from(await response.arrayBuffer()):response.json();
  }
  if(failOnly)return request('fail');
  let lease=null;
  try{
    const claim=await request('claim');lease=claim.lease;
    if(!UUID.test(lease||''))throw new Error('INVALID_PORTFOLIO_WORKER_CLAIM');
    if(claim.phase==='draft'){
      let extractedText='';
      if(claim.request?.sourceMode==='portfolio'){
        const temp=await fs.mkdtemp(path.join(os.tmpdir(),'career-ops-intake-'));
        const docs=path.join(temp,'documents');await fs.mkdir(docs,{recursive:true});const pdfPath=path.join(docs,`${claim.runId}.pdf`);
        try{const pdf=await request('source-pdf',{lease},true);if(pdf.length<100||pdf.length>4_000_000||pdf.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('PORTFOLIO_INTAKE_PDF_INVALID');await fs.writeFile(pdfPath,pdf);extractedText=extract(pdfPath,{maxChars:120_000});}
        finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{})}
      }
      const result=await request('draft',{lease,...(extractedText?{extractedText}:{})});
      console.log(JSON.stringify({runId:id,status:result.status,phase:result.phase}));return result;
    }
    if(claim.phase!=='render')throw new Error('INVALID_PORTFOLIO_WORKER_CLAIM');
    const receipt=await renderPortfolioClaim(claim,{root});const result=await request('complete',{lease,receipt});
    console.log(JSON.stringify({runId:id,status:result.status,version:result.version||null}));return result;
  }catch(error){if(error.message!=='PORTFOLIO_RUN_NOT_CLAIMABLE'){try{await request('fail',{lease,errorCode:'PORTFOLIO_WORKER_FAILED'})}catch{}}throw error}
}
if(isMainModule(import.meta.url)){
  if(process.argv.includes('--help')||process.argv.includes('-h'))console.log('Usage: node web/scripts/cloud-portfolio-worker.mjs [--fail]');
  else runCloudPortfolioWorker({failOnly:process.argv.includes('--fail')}).catch(()=>{console.error('Career Ops portfolio worker failed; inspect the durable run status.');process.exitCode=1});
}
