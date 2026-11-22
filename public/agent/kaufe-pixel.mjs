// Prepare an order for inspection before authorising any transfers.
const [x,y,w='1',h='1',agent='my-agent']=process.argv.slice(2);
if(process.env.SALON_TERMS!=='2026-11-22') throw Error('Read /terms.html and set SALON_TERMS=2026-11-22');
const site=process.env.SALON_SITE || 'https://salon-x402.vercel.app';
const res=await fetch(new URL('/api/order',site),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({x:Number(x),y:Number(y),w:Number(w),h:Number(h),agent,terms:process.env.SALON_TERMS})});
console.log(await res.text());
if(!res.ok)process.exitCode=1;
