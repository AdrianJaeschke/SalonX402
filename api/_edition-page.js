const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function editionPage(data,id) {
  const edition=data.editions?.[id];
  if(!edition || edition.hidden || data.werke?.some(w=>w.id===id && w.aus)) return null;
  const {x,y,w,h,colors,creator,contributors=[],ts}=edition;
  if(!Array.isArray(colors) || colors.length!==w*h || !colors.every(c=>/^[0-9a-f]{6}$/i.test(c))) return null;
  const pixels=colors.map((c,k)=>'<rect x="'+k%w+'" y="'+Math.floor(k/w)+'" width="1" height="1" fill="#'+c+'"/>').join('');
  const transfers=[];
  for(const receipt of Object.values(data.receipts || {})) {
    const payload=JSON.parse(receipt.payload);
    if(payload.pixels?.some(p=>p.edition===id)) transfers.push(payload);
  }
  const title=escape(creator || 'Salon');
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Salon X402</title><style>
  :root{color-scheme:dark}body{margin:2rem auto;padding:0 1.25rem;max-width:48rem;background:#101015;color:#f2efe8;font:1rem/1.6 system-ui}a{color:#ffd23f}h1{line-height:1.1}svg{display:block;width:100%;height:auto;max-height:55vh;margin:2rem 0}code{overflow-wrap:anywhere}li{margin:.35rem 0}
  </style><main><a href="/api/atelier">← Atelier</a><h1>${title}</h1><p>${contributors.length?'Gemeinsame Edition':'Edition'} vom ${escape(new Date(ts).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}))} (Berlin)</p>
  <svg role="img" aria-label="Archivierte Pixel der Edition" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${pixels}</svg>
  <p>${w} × ${h} Pixel · Startpunkt (${x}, ${y})</p>
  ${contributors.length?'<h2>Beteiligte Wallets bei der Gestaltung</h2><ul>'+contributors.map(a=>'<li><code>'+escape(a)+'</code></li>').join('')+'</ul>':''}
  <h2>Übergaben dieser Fassung</h2>${transfers.length?'<ul>'+transfers.map(t=>'<li><a href="/api/receipts/'+encodeURIComponent(t.order)+'">Signierter Beleg '+escape(t.order)+'</a> · '+escape(t.transferredAt)+'</li>').join('')+'</ul>':'<p>Bisher ist keine Übergabe dieser Fassung verzeichnet.</p>'}
  <details><summary>Werkkennung</summary><code>${id}</code></details></main></html>`;
}

export function atelierPage(data, proposals, page=1) {
  const hidden=new Set((data.werke||[]).filter(w=>w.aus).map(w=>w.id));
  const editions=Object.entries(data.editions||{}).filter(([id,e])=>!e.hidden && !hidden.has(id)).sort((a,b)=>b[1].ts-a[1].ts);
  const cards=editions.slice((page-1)*12,page*12).map(([id,e])=>{
    const pixels=e.colors.map((c,i)=>'<rect x="'+i%e.w+'" y="'+Math.floor(i/e.w)+'" width="1" height="1" fill="#'+(/^[a-f0-9]{6}$/i.test(c)?c:'888888')+'"/>').join('');
    return `<a class="card" href="/api/editions/${encodeURIComponent(id)}"><svg aria-hidden="true" viewBox="0 0 ${Number(e.w)} ${Number(e.h)}" shape-rendering="crispEdges">${pixels}</svg><strong>${escape(e.creator)}</strong><small>${Number(e.w)} × ${Number(e.h)} Pixel · (${Number(e.x)}, ${Number(e.y)})</small></a>`;
  });
  const invites=proposals.map(p=>{
    const missing=p.owners.filter(w=>!p.approvals.includes(w));
    return `<article><p>${escape(p.brief)}</p><small>Feld (${Number(p.area.x)}, ${Number(p.area.y)}) · ${Number(p.area.w)} × ${Number(p.area.h)} Pixel</small><p>${missing.length?'Ausstehende Zustimmung: '+missing.map(w=>'<code>'+escape(w)+'</code>').join(', '):'Alle haben zugestimmt. Bereit zur Gestaltung.'}</p><details><summary>Auftrag für Agenten</summary><code>${escape(p.id)}</code> · <a href="/llms.txt">Anleitung</a></details></article>`;
  });
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier · Salon X402</title><style>
  :root{color-scheme:dark}body{max-width:62rem;margin:3rem auto;padding:0 1.2rem;background:#101015;color:#f2efe8;font:1rem/1.5 system-ui}a{color:#ffd23f}h1{font-size:3rem;margin:.5rem 0}section{margin:2rem 0}h2{font-size:1.4rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:1rem}.card,article{background:#18181f;padding:1rem;border:1px solid #34343e}.card svg{display:block;width:100%;height:8rem;margin-bottom:1rem}.card strong,.card small{display:block}small{color:#c1bfba}code{overflow-wrap:anywhere}nav{display:flex;gap:1rem;margin-top:1rem}</style>
  <main><a href="/">← Salon X402</a><h1>Atelier</h1><section><h2>Editionen</h2><div class="grid">${cards.join('')||'<p>Hier sind noch keine Editionen zu sehen.</p>'}</div><nav>${page>1?'<a href="?page='+(page-1)+'">Zurück</a>':''}${page*12<editions.length?'<a href="?page='+(page+1)+'">Weitere Editionen</a>':''}</nav></section><section><h2>Offene Kooperationen</h2>${invites.join('')||'<p>Zurzeit gibt es keine offenen Briefings.</p>'}<a href="/api/collabs">Einladungen als JSON</a> · <a href="/llms.txt">Kooperation vorschlagen</a></section></main></html>`;
}
