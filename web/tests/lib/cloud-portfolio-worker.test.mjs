import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {renderPortfolioClaim} from '../../scripts/cloud-portfolio-worker.mjs';

const uuid='123e4567-e89b-42d3-a456-426614174000';
const pdf=Buffer.from('%PDF-1.7\n'.padEnd(550,'x')+'\n%%EOF\n');
const claim={runId:uuid,lease:'223e4567-e89b-42d3-a456-426614174000',phase:'render',format:'a4',maxPages:12,html:'<!doctype html><html><body>Review</body></html>'};

test('portfolio worker runs strict twelve-page rendering and deletes its temporary PDF',async()=>{
  let inputPath,outputPath,bootstrapPath;let receivedArgs=[];
  const result=await renderPortfolioClaim(claim,{root:'C:/synthetic/repo',run:async(_command,args)=>{receivedArgs=args;const preload=args.indexOf('--import');bootstrapPath=fileURLToPath(args[preload+1]);inputPath=args[preload+3];outputPath=args[preload+4];const bootstrap=await fs.readFile(bootstrapPath,'utf8');assert.match(bootstrap,/CAREER_OPS_ROOT=/);assert.match(bootstrap,/CAREER_OPS_TRACKER/);assert.match(await fs.readFile(inputPath,'utf8'),/Review/);assert.equal(inputPath.includes('career-ops-portfolio-'),true);await fs.writeFile(outputPath,pdf)}});
  assert.equal(result.byteSize,pdf.length);assert.equal(Buffer.from(result.pdfBase64,'base64').equals(pdf),true);
  assert.ok(receivedArgs.includes('--max-pages=12'));assert.ok(receivedArgs.includes('--strict-pages'));
  await assert.rejects(()=>fs.stat(inputPath),{code:'ENOENT'});await assert.rejects(()=>fs.stat(outputPath),{code:'ENOENT'});await assert.rejects(()=>fs.stat(bootstrapPath),{code:'ENOENT'});
});

test('portfolio worker rejects malformed claims before spawning the renderer',async()=>{
  let called=false;
  await assert.rejects(()=>renderPortfolioClaim({...claim,maxPages:2},{run:async()=>{called=true}}),/INVALID_PORTFOLIO_WORKER_CLAIM/);
  assert.equal(called,false);
});
