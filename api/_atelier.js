import {createHash} from 'node:crypto';

const palettes = {
  dusk: ['192640','284769','327f89','7dc3b6','eeb489','c36159'],
  ember: ['331735','783451','bf5452','e58350','f4bd77','fff0ba'],
  frost: ['162244','28456e','376784','619ea2','a7d5c4','e7efdb']
};

function mix(a,b,t) {
  return [0,2,4].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*(1-t)+parseInt(b.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');
}

export function paint(brief,w,h,cells) {
  const seed=createHash('sha256').update(JSON.stringify([brief,w,h,cells.map(s=>[s?.c,s?.w])])).digest('hex');
  const phase=parseInt(seed.slice(0,8),16)/0x100000000 * 2*Math.PI;
  const palette=/dusk|abend|dämmer/i.test(brief)?palettes.dusk:/warm|feuer|fire|rot|red/i.test(brief)?palettes.ember:palettes.frost;
  const weave=/web|weav|faden|thread|textil/i.test(brief);
  const calm=/ruhig|calm|still/i.test(brief);
  const colors=cells.map((s,k)=>{
    const x=k%w,y=Math.floor(k/w),u=(x+0.5)/w,v=(y+0.5)/h;
    const flow=0.50+0.15*Math.sin(6*u+phase)+0.07*Math.sin(10*u-phase);
    const band=Math.abs(v-flow);
    const seam=(x>0 && cells[k-1]?.w!==s?.w)||(y>0 && cells[k-w]?.w!==s?.w);
    const ripple=Math.sin((v-flow)*(calm?20:38)+phase);
    const thread=Math.sin(24*u+3*Math.cos(7*v+phase))*Math.cos(22*v+phase);
    let ink;
    if(weave) ink=palette[thread>.55?5:thread>0?3:thread<-.55?1:2];
    else if(band<.035) ink=palette[4];
    else if(band<.095) ink=palette[ripple>0?5:3];
    else ink=palette[ripple>.82?3:ripple>.15?2:ripple>-.62?1:0];
    if(seam) ink=mix(ink,palette[4],.48);
    return /^[0-9a-f]{6}$/i.test(s?.c||'')?mix(ink,s.c,.22):ink;
  });
  return {colors,seed,artist:weave?'Weberei':'Gezeiten',version:'atelier-1'};
}
