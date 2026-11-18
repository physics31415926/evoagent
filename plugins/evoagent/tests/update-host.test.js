import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateTools } from '../update-host.js';
const exec = () => ({ signal: new AbortController().signal });
const tool = (updater, install) => createUpdateTools(updater, x => x, install)[0];
test('offline status and check do not install', async () => {
  let checked=0, installed=0;
  const t=tool({status:()=>({installed:'0.2.0'}),check:async()=>{checked++;return {newer:true};}},async()=>{installed++;});
  assert.equal((await t.execute({action:'status'},exec())).installed,'0.2.0');
  await t.execute({action:'check'},exec());
  assert.equal(checked,1); assert.equal(installed,0);
});
test('install requires version-specific explicit approval', async () => {
  let downloads=0;
  const t=tool({download:async()=>{downloads++;}},async()=>{});
  await assert.rejects(t.execute({action:'prepare',version:'0.3.0'},exec()),/explicit_version/);
  await assert.rejects(t.execute({action:'prepare',confirmed:true},exec()),/explicit_version/);
  assert.equal(downloads,0);
});
test('prepare returns verified target but never reports installed', async () => {
  const t=tool({status:()=>({installed:'0.2.0'}),download:async({version})=>({release:{version},bytes:Buffer.from('ok')})},async()=>'/tmp/verified.tgz');
  const r=await t.execute({action:'prepare',version:'0.3.0',confirmed:true},exec());
  assert.equal(r.installed,false);assert.equal(r.integrityVerified,true);assert.equal(r.installTarget,'/tmp/verified.tgz');assert.equal(r.to,'0.3.0');
});
test('serialises installs and propagates cancellation before dispatch', async () => {
  let finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const t=tool({status:()=>({installed:'0.2.0'}),download:async()=>{await pending;return {release:{version:'0.3.0'},bytes:Buffer.alloc(0)};}},async()=>({applied:true}));
  const c=new AbortController(); const args={action:'prepare',version:'0.3.0',confirmed:true};
  const first=t.execute(args,{signal:c.signal});
  await assert.rejects(t.execute(args,exec()),/update_in_progress/);
  c.abort(); finish(); await assert.rejects(first,{name:'AbortError'});
});
