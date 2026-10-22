import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPortfolioStore,PortfolioError} from '../../src/lib/portfolio-cloud.mjs';
import {__test as runContracts} from '../../src/lib/portfolio-runs.mjs';

test('metadata mutations reject stale revisions before issuing a write',async()=>{
  const id=randomUUID(),op=randomUUID(),writes=[];
  const sql={query:async(q,args)=>{
    if(q.includes('FROM career_ops_portfolio_operations WHERE'))return [];
    if(q.includes('INSERT INTO career_ops_portfolio_operations'))return [{operation_id:op}];
    if(q.includes('FROM career_ops_portfolios WHERE id=$1'))return [{id,title:'Portfolio',kind:'master',tags:[],project_ids:[],revision:7,archived_at:null}];
    writes.push(q);return [];
  }};
  await assert.rejects(()=>createPortfolioStore(sql).command({operationId:op,operation:'update-metadata',id,expectedRevision:6,changes:{title:'Changed'}}),{message:'PORTFOLIO_STALE_REVISION'});
  assert.equal(writes.some(q=>q.startsWith('UPDATE career_ops_portfolios SET title=')),false);
});

test('operation UUID replay returns its result and rejects changed payloads',async()=>{
  const id=randomUUID(),op=randomUUID(),result={id,title:'Saved',revision:3};
  const sql={query:async(q,args)=>q.includes('FROM career_ops_portfolio_operations WHERE')?[{payload_sha256:args[0]===op?"same":"",result}]:[]};
  const store=createPortfolioStore(sql);
  // Compute the same normalized command hash via a tiny insert capture on the first invocation.
  let hash;
  sql.query=async(q,args)=>{
    if(q.includes('FROM career_ops_portfolio_operations WHERE'))return hash?[{payload_sha256:hash,result}]:[];
    if(q.includes('INSERT INTO career_ops_portfolio_operations')){hash=args[1];return [{operation_id:op}];}
    if(q.includes('FROM career_ops_portfolios WHERE id=$1'))return [{id,title:'Saved',kind:'master',tags:[],project_ids:[],revision:3,archived_at:null}];
    if(q.includes('WITH changed AS (UPDATE career_ops_portfolios p SET title='))return [{result}];
    return [];
  };
  const command={operationId:op,operation:'update-metadata',id,expectedRevision:3,changes:{title:'Saved'}};
  const first=await store.command(command);
  assert.equal(first.title,'Saved');
  assert.deepEqual(await store.command(command),result);
  await assert.rejects(()=>store.command({...command,changes:{title:'Different'}}),{message:'PORTFOLIO_OPERATION_REPLAY_MISMATCH'});
});

test('generated version writer only accepts scoped portfolio PDFs and structured content',async()=>{
  const id=randomUUID(),runId=randomUUID(),queries=[];
  const lease=randomUUID();
  const sql={query:async(q,args)=>{queries.push([q,args]);if(q.includes('SELECT portfolio_id,version,document_path,sha256,byte_size FROM completed'))return [{portfolio_id:id,version:1,document_path:args[3],sha256:args[5],byte_size:args[6]}];return [];}};
  const pdf=Buffer.from('%PDF-1.7\n'.padEnd(550,'x')+'\n%%EOF\n');
  const doc={name:'Candidate',headline:'Engineer',summary:'',highlights:[],projects:[],skills:[],links:[]};
  const result=await createPortfolioStore(sql).saveGeneratedVersion({portfolioId:id,runId,lease,document:doc,bytes:pdf,expectedRevision:2});
  assert.equal(result.version,1);
  const insert=queries.find(([q])=>q.includes('INSERT INTO career_ops_documents'));
  assert.ok(insert[1][3].startsWith(`portfolios/${id}-`));
  assert.equal(insert[1][3],`portfolios/${id}-${runId}.pdf`);
  await assert.rejects(()=>createPortfolioStore({query:async()=>[]}).saveGeneratedVersion({portfolioId:id,runId,lease,document:{...doc,links:[{label:'bad',url:'javascript:1'}]},bytes:pdf,expectedRevision:2}),PortfolioError);
});

test('quantified and scope claims need exact primary evidence, and unknown paraphrases stay suppressed',()=>{
  const paths=['cv.md','config/profile.yml','modes/_profile.md','article-digest.md'];
  const sources=['Managed a team of 4 engineers across delivery.', '', '', ''];
  const document={name:'Candidate',headline:'Engineer',summary:'Managed a team of 4 engineers.',highlights:[],projects:[],skills:[],links:[]};
  assert.deepEqual(runContracts.validateEvidence(document,[{claim:document.summary,sourcePath:'cv.md',quote:sources[0]}],sources,paths,'profile'),[]);
  assert.throws(()=>runContracts.validateEvidence(document,[{claim:document.summary,sourcePath:'cv.md',quote:'Invented management experience with 4 engineers.'}],sources,paths,'profile'),{message:'PORTFOLIO_EVIDENCE_INVALID'});
  assert.throws(()=>runContracts.validateEvidence(document,[],sources,paths,'profile'),{message:'PORTFOLIO_SOURCE_REVIEW_REQUIRED'});
  assert.equal(runContracts.similarClaim('Oversaw a team of 20 people.','Led delivery to twenty people.'),true);
});
