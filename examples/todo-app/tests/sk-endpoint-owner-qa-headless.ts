// Separate ephemeral Playwright, never a browser-control headless option/relay.
export {};
// Run only against an authorized unique server; use a new server per invocation.
if(process.env.SK_ENDPOINT_OWNER_QA_AUTHORIZE_HEADLESS!=='yes')throw Error('Parent headless authorization required');
const url=process.argv[2];if(!url)throw Error('Explicit unique origin URL required');
const modulePath=process.env.SK_ENDPOINT_OWNER_QA_PLAYWRIGHT;
if(!modulePath)throw Error('Explicit installed Playwright module path required');
const {chromium}=await import(modulePath);
const browser=await chromium.launch({headless:true});
const context=await browser.newContext();const page=await context.newPage();
const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(String(error)));
try{
 await page.goto(url);
 const phase=async(expected:string)=>{await page.waitForFunction((value:string)=>(window as unknown as {endpointOwnerQA:{phase:string}}).endpointOwnerQA.phase===value,expected,{timeout:120000});};
 await page.getByRole('button',{name:'Start owned fixture',exact:true}).click();await phase('reading');
 await page.getByRole('button',{name:'Close admission / hold cancel',exact:true}).click();await phase('held');
 await page.getByRole('button',{name:'Request runtime stop',exact:true}).click();await phase('stopping');
 await page.getByRole('button',{name:'Attempt replacement (public guard)',exact:true}).click();
 await page.waitForFunction(()=>(window as unknown as {endpointOwnerQA:{replacementAttempts:string[]}}).endpointOwnerQA.replacementAttempts.length===1);
 const held=await page.evaluate(()=>(window as unknown as {endpointOwnerQA:unknown}).endpointOwnerQA);
 await page.getByRole('button',{name:'Release / reject cancellation',exact:true}).click();await phase(new URL(url).searchParams.get('case')==='reject'?'ownership-negative':'complete');
 const final=await page.evaluate(()=>(window as unknown as {endpointOwnerQA:unknown}).endpointOwnerQA);
 console.log(JSON.stringify({held,final,errors,cleanupLabel:new URL(url).searchParams.get('case')==='reject'?'forced-profile-disposal-after-expected-ownership-negative-NOT-normal-close':'normal-fixture-close-before-profile-disposal'},null,2));
 if(errors.length)throw Error('Raw browser exceptions observed');
}finally{await context.close();await browser.close();}
