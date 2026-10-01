import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
test('existing scanner and Greenhouse adapter emit fresh filtered, deduplicated partial receipts',async()=>{
  const data=await fs.mkdtemp(path.join(os.tmpdir(),'career-ops-live-cli-'));
  try{
    await fs.mkdir(path.join(data,'data'),{recursive:true});
    await fs.writeFile(path.join(data,'portals.yml'),'title_filter:\n  positive: [Engineer]\nlocation_filter:\n  allow: [Ottawa]\ntracked_companies:\n  - name: Example\n    api: https://boards-api.greenhouse.io/v1/boards/example/jobs\n  - name: Broken\n    api: https://boards-api.greenhouse.io/v1/boards/broken/jobs\n');
    const preload=path.join(data,'mock.mjs');
    await fs.writeFile(preload,`globalThis.fetch=async url=>{
      if(String(url).includes('/broken/'))throw new Error('Fixture provider failure');
      return Response.json({jobs:[
        {title:'Software Engineer',absolute_url:'https://example.com/known',location:{name:'Ottawa'},first_published:new Date(Date.now()-86400000).toISOString()},
        {title:'Data Engineer',absolute_url:'https://example.com/new',location:{name:'Ottawa'},first_published:new Date(Date.now()-2*86400000).toISOString()},
        {title:'Data Engineer',absolute_url:'https://example.com/new',location:{name:'Ottawa'},first_published:new Date(Date.now()-2*86400000).toISOString()},
        {title:'Old Engineer',absolute_url:'https://example.com/old',location:{name:'Ottawa'},first_published:'2020-01-01T00:00:00Z'},
        {title:'Cloud Engineer',absolute_url:'https://example.com/unknown',location:{name:'Ottawa'}}
      ]});
    };`);
    await fs.writeFile(path.join(data,'data/pipeline.md'),'- [x] https://example.com/known | Example | Software Engineer\n');
    const output=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,path.join(ROOT,'scan.mjs'),'--dry-run','--json','--since','5','--quiet'],{cwd:data,encoding:'utf8',timeout:30000,env:{...process.env,CAREER_OPS_ROOT:data,CAREER_OPS_DATA_DIR:data,CAREER_OPS_PORTALS:path.join(data,'portals.yml'),CAREER_OPS_PIPELINE:path.join(data,'data/pipeline.md'),CAREER_OPS_SCAN_HISTORY:path.join(data,'data/scan-history.tsv')}});
    assert.equal(output.status,0,output.stderr);const receipt=JSON.parse(output.stdout.trim());
    assert.equal(receipt.version,'careerops.scan.live@1');assert.equal(receipt.jobs.length,3);
    assert.equal(receipt.jobs.find(j=>j.url.endsWith('/known')).known,true);
    assert.equal(receipt.jobs.find(j=>j.url.endsWith('/unknown')).postedAt,null);
    assert.ok(!receipt.jobs.some(j=>j.url.endsWith('/old')));
    assert.equal(receipt.sources.find(s=>s.company==='Broken').status,'failed');
    assert.ok(Date.parse(receipt.completedAt)>=Date.parse(receipt.startedAt));
    assert.equal(await fs.readFile(path.join(data,'data/pipeline.md'),'utf8'),'- [x] https://example.com/known | Example | Software Engineer\n');
  }finally{await fs.rm(data,{recursive:true,force:true});}
});
