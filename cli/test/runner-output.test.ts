import assert from "node:assert/strict";
import test from "node:test";
import {performRun,withoutCredentials} from "../dist/cli/src/runner.js";

test("a native run masks split stdout/stderr before shipping and skips credential-run artifacts",async()=>{
 const originalFetch=globalThis.fetch, originalWrite=process.stdout.write, originalToken=process.env.CODEROOK_TOKEN;
 const originalNpm=process.env.NPM_TOKEN;
 const shipped:string[]=[];let displayed="";
 const dummy="DUMMY_split_release_secret_42";
 process.env.CODEROOK_TOKEN="dummy-runner-auth";
 process.env.NPM_TOKEN="dummy-host-token-must-not-be-inherited";
 process.stdout.write=((chunk:unknown)=>{displayed+=String(chunk);return true;}) as typeof process.stdout.write;
 globalThis.fetch=(async(_url:unknown,init?:RequestInit)=>{
  if(init?.body){const body=JSON.parse(String(init.body));for(const entry of body.lines??[])shipped.push(entry.line);}
  return new Response("{}",{headers:{"content-type":"application/json"}});
 }) as typeof fetch;
 try{
  const code="const v=process.env.DEPLOY_TOKEN;process.stdout.write(v.slice(0,7));setTimeout(()=>{process.stdout.write(v.slice(7)+'\\n');process.stderr.write(v);if(process.env.NPM_TOKEN)process.exitCode=9;if(!process.env.TEMP.includes('coderook-run-'))process.exitCode=10;},50)";
  const result=await performRun("dummy-project",{runId:"dummy-run",number:1,workflowId:"dummy-workflow",workflowName:"Dummy",command:`node -e "${code}"`,workingDirectory:null,versionId:null,versionSequence:null,attempts:1,environment:{DEPLOY_TOKEN:dummy},secretNames:["DEPLOY_TOKEN"],artifactsAllowed:false,artifactPaths:["**"]},"dummy-runner");
  assert.equal(result.status,"passed");
  const output=shipped.join("\n")+displayed;
  assert.ok(output.includes("***"));
  assert.ok(output.includes("Artifacts disabled"));
  assert.ok(!output.includes(dummy));
  assert.ok(!output.includes(dummy.slice(0,7)));
  assert.ok(!output.includes(dummy.slice(7)));
 }finally{
  globalThis.fetch=originalFetch;process.stdout.write=originalWrite;
  if(originalToken===undefined)delete process.env.CODEROOK_TOKEN;else process.env.CODEROOK_TOKEN=originalToken;
  if(originalNpm===undefined)delete process.env.NPM_TOKEN;else process.env.NPM_TOKEN=originalNpm;
 }
});

test("native child environment inherits tool paths, not the host's other service credentials",()=>{
 const safe=withoutCredentials({PATH:"tools",SystemRoot:"Windows",NPM_TOKEN:"dummy",AWS_SECRET_ACCESS_KEY:"dummy",DATABASE_URL:"dummy",CODEROOK_TOKEN:"dummy",CUSTOM_LOGIN:"dummy"});
 assert.deepEqual(safe,{PATH:"tools",SystemRoot:"Windows"});
});
