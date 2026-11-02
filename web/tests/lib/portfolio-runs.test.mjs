import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createPortfolioRunStore} from '../../src/lib/portfolio-runs.mjs';

const pdf=Buffer.from('%PDF-1.7\n'.padEnd(550,'x')+'\n%%EOF\n');
const baseDocument={name:'Synthetic candidate',headline:'Engineer',summary:'Manual draft.',highlights:[],projects:[],skills:['JavaScript'],links:[]};
const ownerSources={
  'cv.md':{content_encoding:'utf8',content:'Synthetic Candidate, an engineer skilled in JavaScript.',sha256:'cv'},
  'config/profile.yml':{content_encoding:'utf8',content:'candidate: { full_name: Synthetic Candidate }',sha256:'profile'},
  'modes/_profile.md':{content_encoding:'utf8',content:'Target backend engineering roles.',sha256:'target'},
  'article-digest.md':{content_encoding:'utf8',content:'',sha256:'digest'},
};
const env={DATABASE_URL:'fixture',GEMINI_API_KEY:'fixture',CAREER_OPS_SCAN_DISPATCH_TOKEN:'fixture',CAREER_OPS_SCAN_WORKER_SECRET:'fixture',CAREER_OPS_SCAN_REF:'main'};

function fixture({aiText=JSON.stringify({document:baseDocument}),now=()=>new Date(),extraSources={},workerEnv=env}={}){
  const runs=new Map(),operations=new Map(),decisions=new Map(),versions=new Map();let dispatchCount=0,aiCount=0;
  const portfolio={id:randomUUID(),title:'Synthetic portfolio',kind:'master',tags:[],projectIds:[],revision:4,archivedAt:null};
  let sourceApplyCount=0;
  const sql={async query(query,args=[]){
    if(/^(CREATE|ALTER)/i.test(query.trim()))return [];
    if(query.includes('SELECT payload_sha256,result FROM career_ops_portfolio_run_operations')){const op=operations.get(args[0]);return op?[{payload_sha256:op.payload_sha256,result:op.result??null}]:[]}
    if(query.includes('INSERT INTO career_ops_portfolio_run_operations')){if(!operations.has(args[0]))operations.set(args[0],{payload_sha256:args[1],target_run_id:args[2]||null});return []}
    if(query.includes('UPDATE career_ops_portfolio_run_operations SET result=')){const op=operations.get(args[0]);if(op)op.result=JSON.parse(args[1]);return []}
    if(query.includes('UPDATE career_ops_portfolio_run_operations SET target_run_id=')){const op=operations.get(args[0]);if(op)op.target_run_id=args[1];return []}
    if(query.includes('SELECT outcome FROM career_ops_portfolio_claim_decisions')){const d=decisions.get(args[0]);return d?[{outcome:d.outcome}]:[]}
    if(query.includes('SELECT claim_text,outcome FROM career_ops_portfolio_claim_decisions'))return [...decisions.values()].filter(d=>d.provenance.portfolioId===args[0]&&String(d.provenance.version)===args[1]).map(({claim_text,outcome})=>({claim_text,outcome}));
    if(query.includes('INSERT INTO career_ops_portfolio_claim_decisions')){decisions.set(args[0],{claim_text:args[1],outcome:args[2],provenance:JSON.parse(args[3])});return []}
    if(query.includes('SELECT * FROM career_ops_portfolio_runs WHERE operation_id=')&&!query.includes('INSERT INTO career_ops_portfolio_runs(')){const row=[...runs.values()].find(item=>item.operation_id===args[0]);return row?[row]:[]}
    if(query.includes('SELECT * FROM career_ops_portfolio_runs WHERE id=')){const row=runs.get(args[0]);return row?[row]:[]}
    if(query.includes('SELECT id FROM career_ops_portfolio_projects WHERE id=ANY'))return (args[0]||[]).map(id=>({id}));
    if(query.includes('SELECT revision,archived_at FROM career_ops_portfolios'))return [{revision:portfolio.revision,archived_at:portfolio.archivedAt}];
    if(query.includes('SELECT sha256 FROM career_ops_portfolio_versions'))return args[0]===portfolio.id&&[1,2].includes(args[1])?[{sha256:'a'.repeat(64)}]:[];
    if(query.includes('INSERT INTO career_ops_portfolio_runs(')){
      const row={id:args[0],operation_id:args[1],state:args[2],phase:args[3],request:JSON.parse(args[4]),portfolio_id:args[5],expected_revision:args[6],source_version:args[7],source_sha256:args[8],source_revision:args[9],document_json:args[10]?JSON.parse(args[10]):null,draft_sha256:args[11],format:args[12],source_hashes:{},source_review:null,fact_preview:null,action_receipt:null,requested_at:now(),started_at:null,completed_at:null,error_code:null,lease:null,lease_expires_at:null,version:null,pdf_sha256:null,pdf_byte_size:null,pdf_path:null};runs.set(row.id,row);return [row]
    }
    if(query.includes("SET state='failed',error_code='PORTFOLIO_WORKER_DISPATCH_FAILED'")){const row=runs.get(args[0]);if(row){row.state='failed';row.error_code='PORTFOLIO_WORKER_DISPATCH_FAILED'}return row?[row]:[]}
    if(query.includes("SET state='running',lease=$2")){const row=runs.get(args[0]);if(!row||!(row.state==='queued'||row.state==='running'&&row.lease_expires_at<=now()))return [];Object.assign(row,{state:'running',lease:args[1],lease_expires_at:new Date(now().getTime()+15*60_000),started_at:now()});return [row]}
    if(query.includes("SET state='awaiting_review',document_json=$3")){const row=runs.get(args[0]);if(!row||row.state!=='running'||row.lease!==args[1]||row.lease_expires_at<=now())return [];Object.assign(row,{state:'awaiting_review',document_json:JSON.parse(args[2]),draft_sha256:args[3],source_hashes:JSON.parse(args[4]),source_review:JSON.parse(args[5]),fact_preview:args[6]?JSON.parse(args[6]):null,lease:null,lease_expires_at:null});return [row]}
    if(query.includes("SET document_json=$2::jsonb,draft_sha256=$3,request=$4::jsonb,format=$6")){const row=runs.get(args[0]);if(!row||row.state!=='awaiting_review'||row.draft_sha256!==args[4])return [];Object.assign(row,{document_json:JSON.parse(args[1]),draft_sha256:args[2],request:JSON.parse(args[3]),format:args[5],action_receipt:JSON.parse(args[6])});return [row]}
    if(query.includes("SET document_json=$2::jsonb,draft_sha256=$3,source_review=$4::jsonb,fact_preview=$5::jsonb")){const row=runs.get(args[0]);if(!row||row.state!=='awaiting_review'||row.draft_sha256!==args[5])return [];Object.assign(row,{document_json:JSON.parse(args[1]),draft_sha256:args[2],source_review:JSON.parse(args[3]),fact_preview:JSON.parse(args[4])});return [row]}
    if(query.includes("SET fact_preview=$2::jsonb")){const row=runs.get(args[0]);if(!row||row.state!=='awaiting_review'||row.draft_sha256!==args[2])return [];Object.assign(row,{fact_preview:JSON.parse(args[1]),action_receipt:JSON.parse(args[3])});return [row]}
    if(query.includes("SET state='queued',phase='render'")){const row=runs.get(args[0]);if(!row||row.state!=='awaiting_review'||row.draft_sha256!==args[1])return [];Object.assign(row,{state:'queued',phase:'render',started_at:null,action_receipt:JSON.parse(args[2])});return [row]}
    if(query.includes("SET state='canceled'")){const row=runs.get(args[0]);if(!row||!['queued','running','awaiting_review'].includes(row.state))return [];Object.assign(row,{state:'canceled',lease:null,lease_expires_at:null,canceled_at:now(),action_receipt:JSON.parse(args[1])});return [row]}
    if(query.includes("SET state='failed',error_code=$3")){const row=runs.get(args[0]);if(!row||!((row.state==='running'&&args[1]&&row.lease===args[1])||(row.state==='queued'&&!args[1])))return [];Object.assign(row,{state:'failed',error_code:args[2],lease:null,completed_at:now()});return [row]}
    throw new Error(`Unexpected fixture query: ${query.slice(0,100)}`);
  }};
  const portfolioStore={
    async detail(id,version){if(id!==portfolio.id||![1,2].includes(version))throw new Error('PORTFOLIO_NOT_FOUND');return {portfolio:{...portfolio},version:{version,sha256:'a'.repeat(64)},document:version===2?baseDocument:null}},
    async download(id,version){if(id!==portfolio.id||version!==1)throw new Error('PORTFOLIO_NOT_FOUND');return pdf},
    async saveGeneratedVersion({portfolioId,runId,lease,bytes,expectedRevision,metadata}){const row=runs.get(runId);if(!row||row.state!=='running'||row.phase!=='render'||row.lease!==lease||row.expected_revision!==expectedRevision)throw new Error('PORTFOLIO_STALE_REVISION');const prior=versions.get(runId);if(prior)return prior;const result={portfolioId,version:(portfolio.revision===expectedRevision?2:1),documentPath:`portfolios/${portfolioId}-${runId}.pdf`,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length};Object.assign(row,{state:'completed',pdf_path:result.documentPath,pdf_sha256:result.sha256,pdf_byte_size:result.byteSize,version:result.version,lease:null,completed_at:now()});Object.assign(portfolio,{revision:portfolio.revision+1,...metadata});versions.set(runId,result);return result;},
  };
  const aiService={status:()=>({ready:true}),async *stream(){aiCount++;yield {type:'text',text:aiText}}};
  const sourceManager={async readSource(){return {sha256:'a'.repeat(64)}},async createProposal(_source,input){return {proposalId:input.operationId,diff:[{path:'target_roles.primary',after:['Engineer']}]};},async applyProposal(_source,input){sourceApplyCount++;return {ok:true,operationId:input.operationId}}};
  const service=createPortfolioRunStore({sql,env:workerEnv,portfolioStore,readDocument:async path=>({...ownerSources,...extraSources})[path]||null,aiService,sourceManager,dispatch:async()=>{dispatchCount++},now});
  return {service,portfolio,decisions,runs,versions,operations,get dispatchCount(){return dispatchCount},get aiCount(){return aiCount},get sourceApplyCount(){return sourceApplyCount}};
}

test('manual edits move through review, revision-bound render, immutable completion and exact callback replay',async()=>{
  const f=fixture();const start=await f.service.start({operationId:randomUUID(),mode:'edit',sourceMode:'profile',kind:'master',title:f.portfolio.title,tags:[],projectIds:[],basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,document:baseDocument,format:'letter'});
  assert.equal(start.status,'awaiting_review');assert.equal(f.aiCount,0);
  const previewBody={operationId:randomUUID(),expectedDraftSha256:start.draftSha256,document:{...baseDocument,summary:'Owner edit.'},title:'Reviewed title'};
  const preview=await f.service.preview(start.runId,previewBody);
  f.operations.get(previewBody.operationId).result=null;
  assert.deepEqual(await f.service.preview(start.runId,previewBody),preview);
  const applyBody={operationId:randomUUID(),expectedDraftSha256:preview.run.draftSha256,confirm:true};
  const queued=await f.service.apply(start.runId,applyBody);
  f.operations.get(applyBody.operationId).result=null;
  assert.equal((await f.service.apply(start.runId,applyBody)).status,'queued');
  assert.equal(queued.status,'queued');assert.equal(f.dispatchCount,1);
  const claim=await f.service.claim(start.runId);assert.equal(claim.phase,'render');assert.match(claim.html,/Owner edit/);
  const receipt={pdfBase64:pdf.toString('base64'),byteSize:pdf.length};const completed=await f.service.complete(start.runId,claim.lease,receipt);
  assert.equal(completed.status,'completed');assert.equal((await f.service.get(start.runId)).version,2);
  assert.equal((await f.service.complete(start.runId,claim.lease,receipt)).version,2);
  await assert.rejects(()=>f.service.complete(start.runId,claim.lease,{...receipt,pdfBase64:Buffer.from('different').toString('base64'),byteSize:9}),{message:'PORTFOLIO_COMPLETION_REPLAY_MISMATCH'});
});

test('the UI PDF-only contract is edit+portfolio, leases an exact binary source, and reviews unknown claims before render',async()=>{
  const aiText=JSON.stringify({document:{...baseDocument,summary:'Led delivery of a platform for 20 clients.'},evidence:[],unverifiedClaims:[{text:'Led delivery of a platform for 20 clients.',kind:'scope',source:'portfolio-pdf'}]});
  const f=fixture({aiText});
  await assert.rejects(()=>f.service.start({operationId:randomUUID(),mode:'generate',sourceMode:'portfolio',kind:'master',title:'Convert',basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,format:'letter'}),{message:'PORTFOLIO_RUN_INPUT_INVALID'});
  const run=await f.service.start({operationId:randomUUID(),mode:'edit',sourceMode:'portfolio',kind:'master',title:f.portfolio.title,tags:[],projectIds:[],basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,format:'letter'});
  assert.equal(run.status,'queued');assert.equal(run.portfolioId,f.portfolio.id);
  const claim=await f.service.claim(run.runId);assert.equal(claim.phase,'draft');assert.equal((await f.service.downloadIntakeSource(run.runId,claim.lease)).equals(pdf),true);
  const drafted=await f.service.draft(run.runId,claim.lease,'Led delivery of a platform for 20 clients.');
  assert.equal(drafted.status,'awaiting_review');assert.equal(drafted.sourceReview.claims.length,1);assert.equal(drafted.sourceReview.claims[0].outcome,null);
  await assert.rejects(()=>f.service.apply(run.runId,{operationId:randomUUID(),expectedDraftSha256:drafted.draftSha256,confirm:true}),{message:'PORTFOLIO_FACTS_REVIEW_REQUIRED'});
  const reviewed=await f.service.factsPreview(run.runId,{operationId:randomUUID(),expectedDraftSha256:drafted.draftSha256,decisions:[{claimId:drafted.sourceReview.claims[0].claimId,outcome:'do-not-know'}]});
  const factsApplyBody={operationId:randomUUID(),previewId:reviewed.factsReview.previewId,expectedDraftSha256:reviewed.run.draftSha256,confirm:true};
  const facts=await f.service.factsApply(run.runId,factsApplyBody);
  const row=f.runs.get(run.runId);row.state='canceled';assert.deepEqual(await f.service.factsApply(run.runId,factsApplyBody),facts);row.state='awaiting_review';
  assert.equal(facts.factsReview.claims[0].outcome,'user-cannot-confirm');assert.equal(f.decisions.size,1);
  const queued=await f.service.apply(run.runId,{operationId:randomUUID(),expectedDraftSha256:facts.run.draftSha256,confirm:true});assert.equal(queued.status,'queued');
});

test('cancellation prevents late draft callbacks and is replay-safe',async()=>{
  const aiText=JSON.stringify({document:baseDocument,evidence:[],unverifiedClaims:[]});const f=fixture({aiText});
  const run=await f.service.start({operationId:randomUUID(),mode:'generate',sourceMode:'profile',kind:'master',title:'Generated',tags:[],projectIds:[],format:'letter'});
  const claim=await f.service.claim(run.runId);const canceled=await f.service.cancel(run.runId,{operationId:randomUUID(),confirm:true});
  assert.equal(canceled.status,'canceled');await assert.rejects(()=>f.service.draft(run.runId,claim.lease),{message:'PORTFOLIO_LEASE_LOST'});
  assert.equal(await f.service.claim(run.runId),null);
});

test('worker misconfiguration is rejected before apply changes the run state',async()=>{
  const f=fixture({workerEnv:{DATABASE_URL:'fixture'}});
  const run=await f.service.start({operationId:randomUUID(),mode:'edit',sourceMode:'profile',kind:'master',title:f.portfolio.title,tags:[],projectIds:[],basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,document:baseDocument,format:'letter'});
  await assert.rejects(()=>f.service.apply(run.runId,{operationId:randomUUID(),expectedDraftSha256:run.draftSha256,confirm:true}),{message:'PORTFOLIO_WORKER_NOT_CONFIGURED'});
  assert.equal((await f.service.get(run.runId)).status,'awaiting_review');
});

test('an expired worker lease is replaced; the stale worker can no longer download source or save a draft',async()=>{
  let instant=new Date('2026-10-22T00:00:00Z');const f=fixture({now:()=>instant,aiText:JSON.stringify({document:baseDocument,evidence:[],unverifiedClaims:[]})});
  const run=await f.service.start({operationId:randomUUID(),mode:'edit',sourceMode:'portfolio',kind:'master',title:f.portfolio.title,tags:[],projectIds:[],basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,format:'letter'});
  const first=await f.service.claim(run.runId);instant=new Date(instant.getTime()+16*60_000);const replacement=await f.service.claim(run.runId);
  assert.notEqual(replacement.lease,first.lease);
  await assert.rejects(()=>f.service.downloadIntakeSource(run.runId,first.lease),{message:'PORTFOLIO_LEASE_LOST'});
  await assert.rejects(()=>f.service.draft(run.runId,first.lease,'Extracted source with enough characters to pass the intake limit.'),{message:'PORTFOLIO_LEASE_LOST'});
});

test('variant generation validates selected master, projects and exact tracker context without linking the tracker',async()=>{
  const tracker='# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report |\n|---|---|---|---|---|---|---|---|\n| 77 | 2026-10-20 | Sample Co | Backend Engineer | 4.2 | Applied | No | — |';
  const f=fixture({extraSources:{'data/applications.md':{content_encoding:'utf8',content:tracker,sha256:'tracker'}}});
  const projectId=randomUUID();
  const run=await f.service.start({operationId:randomUUID(),mode:'generate',sourceMode:'profile',kind:'variant',title:'Backend Engineer Portfolio',tags:['backend'],projectIds:[projectId],basePortfolioId:f.portfolio.id,baseVersion:2,expectedRevision:f.portfolio.revision,applicationNumber:'77',format:'letter'});
  assert.equal(run.status,'queued');assert.notEqual(run.portfolioId,f.portfolio.id);assert.equal(run.expectedRevision,1);assert.deepEqual(run.projectIds,[projectId]);
  const claim=await f.service.claim(run.runId);assert.deepEqual(claim.request.applicationContext,{company:'Sample Co',role:'Backend Engineer',location:'',targetEvidence:''});
  const draft=await f.service.draft(run.runId,claim.lease);assert.equal(draft.status,'awaiting_review');
  await assert.rejects(()=>f.service.start({operationId:randomUUID(),mode:'generate',sourceMode:'profile',kind:'variant',title:'Missing master',tags:[],projectIds:[],format:'letter'}),{message:'PORTFOLIO_MASTER_REQUIRED'});
  await assert.rejects(()=>f.service.start({operationId:randomUUID(),mode:'generate',sourceMode:'profile',kind:'master',title:'Missing tracker',tags:[],projectIds:[],applicationNumber:'99',format:'letter'}),{message:'PORTFOLIO_APPLICATION_NOT_FOUND'});
});

test('stale or canceled fact previews cannot apply a profile proposal or record claim decisions',async()=>{
  const aiText=JSON.stringify({document:{...baseDocument,summary:'Led delivery of a platform.'},evidence:[],unverifiedClaims:[{text:'Led delivery of a platform.',kind:'scope',source:'portfolio-pdf'}]});
  for(const invalidState of ['stale','canceled']){
    const f=fixture({aiText});
    const run=await f.service.start({operationId:randomUUID(),mode:'edit',sourceMode:'portfolio',kind:'master',title:f.portfolio.title,tags:[],projectIds:[],basePortfolioId:f.portfolio.id,baseVersion:1,expectedRevision:f.portfolio.revision,format:'letter'});
    const claim=await f.service.claim(run.runId);const draft=await f.service.draft(run.runId,claim.lease,'Led delivery of a platform. Synthetic extracted source has more than forty characters.');
    const sourceClaim=draft.sourceReview.claims[0];
    const preview=await f.service.factsPreview(run.runId,{operationId:randomUUID(),expectedDraftSha256:draft.draftSha256,decisions:[{claimId:sourceClaim.claimId,outcome:'correct',correctedText:'Engineer'}],profilePatch:{roles:['Engineer']},profileClaimIds:{roles:sourceClaim.claimId}});
    const row=f.runs.get(run.runId);
    if(invalidState==='stale')row.draft_sha256='f'.repeat(64);else row.state='canceled';
    const before=f.sourceApplyCount;
    await assert.rejects(()=>f.service.factsApply(run.runId,{operationId:randomUUID(),previewId:preview.factsReview.previewId,expectedDraftSha256:preview.run.draftSha256,profileProposalId:preview.factsReview.profileProposalId,expectedProfileSha256:preview.factsReview.profileSha256,sourceOperationId:randomUUID(),confirm:true}),{message:'PORTFOLIO_FACTS_PREVIEW_STALE'});
    assert.equal(f.sourceApplyCount,before);assert.equal(f.decisions.size,0);
  }
});
