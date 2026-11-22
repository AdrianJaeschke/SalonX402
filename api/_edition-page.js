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
  </style><main><a href="/">← Salon X402</a><h1>${title}</h1><p>${contributors.length?'Gemeinsame Edition':'Edition'} vom ${escape(new Date(ts).toLocaleString('de-DE',{timeZone:'Europe/Berlin'}))} (Berlin)</p>
  <svg role="img" aria-label="Archivierte Pixel der Edition" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${pixels}</svg>
  <p>${w} × ${h} Pixel · Startpunkt (${x}, ${y})</p>
  ${contributors.length?'<h2>Beteiligte Wallets bei der Gestaltung</h2><ul>'+contributors.map(a=>'<li><code>'+escape(a)+'</code></li>').join('')+'</ul>':''}
  <h2>Übergaben dieser Fassung</h2>${transfers.length?'<ul>'+transfers.map(t=>'<li><a href="/api/receipts/'+encodeURIComponent(t.order)+'">Signierter Beleg '+escape(t.order)+'</a> · '+escape(t.transferredAt)+'</li>').join('')+'</ul>':'<p>Bisher ist keine Übergabe dieser Fassung verzeichnet.</p>'}
  <details><summary>Werkkennung</summary><code>${id}</code></details></main></html>`;
}
