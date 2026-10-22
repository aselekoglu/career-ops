import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePortfolioDocument,renderPortfolioDocument,PortfolioDocumentError} from '../../src/lib/portfolio-document.mjs';

const sample={name:'Ada <Lovelace>',headline:'Engineer & maker',summary:'A "careful" builder',highlights:['One'],projects:[{title:'Project',role:'Lead',summary:'Useful',highlights:['Impact'],skills:['JS'],links:[{label:'Site',url:'https://example.test'}]}],skills:['TypeScript'],links:[]};
test('normalizes the public schema and renders deterministic escaped static HTML',()=>{
  const normalized=normalizePortfolioDocument(sample);
  assert.equal(normalized.schemaVersion,'careerops.portfolio.document@1');
  const html=renderPortfolioDocument(normalized,{format:'a4'});
  assert.equal(html,renderPortfolioDocument(sample,{format:'a4'}));
  assert.match(html,/Ada &lt;Lovelace&gt;/);
  assert.match(html,/Engineer &amp; maker/);
  assert.match(html,/@page\{size:a4/);
  assert.doesNotMatch(html,/<script|<form|remote\.test/);
  assert.notEqual(renderPortfolioDocument({...sample,theme:'editorial'}),renderPortfolioDocument(sample));
});
test('rejects unsafe links, arbitrary theme, oversized arrays and excessive content',()=>{
  assert.throws(()=>normalizePortfolioDocument({...sample,links:[{label:'x',url:'javascript:alert(1)'}]}),PortfolioDocumentError);
  assert.throws(()=>normalizePortfolioDocument({...sample,links:[{label:'x',url:'https://u:p@example.test'}]}),PortfolioDocumentError);
  assert.throws(()=>normalizePortfolioDocument({...sample,theme:'custom-css'}),PortfolioDocumentError);
  assert.throws(()=>normalizePortfolioDocument({...sample,projects:Array(11).fill(sample.projects[0])}),PortfolioDocumentError);
  assert.throws(()=>renderPortfolioDocument(sample,{format:'legal'}),PortfolioDocumentError);
});
