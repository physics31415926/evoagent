import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUpdater } from '../updates.js';
const bytes = Buffer.from('verified archive');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const release = (version='1.2.0', changes={}) => ({ tag_name: `dsh-plugin-v${version}`, body:'notes', published_at:'2026-11-17', draft:false, prerelease:false, assets:[{name:`dsh-evoagent-${version}.tgz`,size:bytes.length,digest,browser_download_url:`https://github.com/physics31415926/evoagent/releases/download/dsh-plugin-v${version}/dsh-evoagent-${version}.tgz`}], ...changes });
const json = body => new Response(JSON.stringify(body));
test('fixed source, highest stable, caching, forced minimum and deduplication', async () => {
  let count=0, time=0;
  const u=createUpdater({version:'1.0.0',linked:false,now:()=>time,fetchImpl:async url=>{
    assert.equal(url,'https://api.github.com/repos/physics31415926/evoagent/releases?per_page=30'); count++;
    return json([release('2.0.0',{prerelease:true}),release('1.1.0'),release(),release('01.3.0'),release('9007199254740992.0.0')]);
  }});
  const [a,b]=await Promise.all([u.check(),u.check()]);
  assert.equal(a.latest.version,'1.2.0'); assert.equal(a.installable,true); assert.deepEqual(a,b); assert.equal(count,1);
  await u.check({refresh:true}); assert.equal(count,1);
  time=30000; await u.check({refresh:true}); assert.equal(count,2);
  time+=60000; await u.check(); assert.equal(count,2);
  a.latest.version='tampered'; assert.equal(u.status().latest.version,'1.2.0');
});
test('strict source assets, exact naming, digest and version gates', async () => {
  for (const mutation of [a=>a.browser_download_url+='?x=1',a=>a.browser_download_url=a.browser_download_url.replace('github.com','github.com:443'),a=>a.name='wrong.tgz',a=>a.size=9*1024*1024]) {
    const r=release(); mutation(r.assets[0]);
    const u=createUpdater({version:'1.0.0',fetchImpl:async()=>json([r])});
    assert.equal((await u.check()).latest,null);
  }
  const r=release(); delete r.assets[0].digest;
  const u=createUpdater({version:'1.0.0',fetchImpl:async()=>json([r])});
  assert.equal((await u.check()).installable,false);
  await assert.rejects(u.download({version:'1.2.0'}),{code:'digest_missing'});
  const linked=createUpdater({version:'1.0.0',linked:true,fetchImpl:async()=>json([release()])});
  await assert.rejects(linked.download({version:'1.2.0'}),{code:'linked_install'});
  const downgrade=createUpdater({version:'2.0.0',fetchImpl:async()=>json([release()])});
  await assert.rejects(downgrade.download({version:'1.2.0'}),{code:'not_newer'});
  await assert.rejects(u.download({version:'1.3.0'}),{code:'release_changed'});
});
test('verified download follows bounded trusted redirects only', async () => {
  const urls=[];
  const u=createUpdater({version:'1.0.0',fetchImpl:async url=>{
    urls.push(url);
    if(url.includes('api.github.com'))return json([release()]);
    if(url.includes('github.com/'))return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file'}});
    return new Response(bytes);
  }});
  const result=await u.download({version:'1.2.0'});
  assert.deepEqual(result.bytes,bytes); assert.equal(urls.length,3);
  for(const location of ['http://github.com/a','https://evil.com/a','https://github.com.evil.com/a','https://user:pass@github.com/a','https://github.com:443/a']){
    const v=createUpdater({version:'1.0.0',fetchImpl:async url=>url.includes('api.github.com')?json([release()]):new Response(null,{status:302,headers:{location}})});
    await assert.rejects(v.download({version:'1.2.0'}),{code:'redirect_denied'});
  }
});
test('download rejects digest, body size, declared size and redirect loops',async()=>{
  for(const [body,code] of [[Buffer.from('wrong archive!!'),'digest_mismatch'],[Buffer.from('short'),'size_mismatch']]){
    const r=release(); r.assets[0].size=body.length;
    if(code==='size_mismatch')r.assets[0].size=bytes.length;
    const u=createUpdater({version:'1.0.0',fetchImpl:async url=>url.includes('api.github.com')?json([r]):new Response(body)});
    await assert.rejects(u.download({version:'1.2.0'}),{code});
  }
  const u=createUpdater({version:'1.0.0',fetchImpl:async url=>url.includes('api.github.com')?json([release()]):new Response('x',{headers:{'content-length':String(9*1024*1024)}})});
  await assert.rejects(u.download({version:'1.2.0'}),{code:'size_limit'});
  const loop=createUpdater({version:'1.0.0',fetchImpl:async url=>url.includes('api.github.com')?json([release()]):new Response(null,{status:302,headers:{location:url}})});
  await assert.rejects(loop.download({version:'1.2.0'}),{code:'redirect_limit'});
});
test('bounded metadata failures are sanitized and cached for sixty seconds',async()=>{
  let count=0,time=0;
  const u=createUpdater({version:'1.0.0',now:()=>time,fetchImpl:async()=>{count++;throw Error('PRIVATE_TOKEN');}});
  assert.equal((await u.check()).checkError,'network_error');
  time=59000;await u.check();assert.equal(count,1);
  time=60000;await u.check();assert.equal(count,2);
  assert.ok(!JSON.stringify(u.status()).includes('PRIVATE_TOKEN'));
  const big=createUpdater({version:'1.0.0',fetchImpl:async()=>new Response('x',{headers:{'content-length':String(2*1024*1024)}})});
  assert.equal((await big.check()).checkError,'size_limit');
  const streamed=createUpdater({version:'1.0.0',fetchImpl:async()=>new Response(new Uint8Array(1024*1024+1))});
  assert.equal((await streamed.check()).checkError,'size_limit');
});
test('parent abort propagates unchanged and metadata stream is cancelled',async()=>{
  const controller=new AbortController(); const reason=Error('parent cancel'); let cancelled=false;
  const u=createUpdater({version:'1.0.0',fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([91]));queueMicrotask(()=>controller.abort(reason));},cancel(){cancelled=true;}}))});
  await assert.rejects(u.check({signal:controller.signal}),e=>e===reason);
  assert.equal(cancelled,true);
  await assert.rejects(u.download({version:'1.2.0',signal:controller.signal}),e=>e===reason);
});
