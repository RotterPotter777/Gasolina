
const expectedFields=['region','district','station_name','brand','lat','lon','osm_id','status','status_code','fuels_now','92','95','98','100','ДТ','confirmations','realCount','last_at'];
const fuelColumns=['92','95','98','100','ДТ'];
const defaultMapCenter=[55.8311,37.3302];
const defaultMapZoom=11;
let data=[]; let filtered=[]; let map=null; let markers=[]; let mapReadyPromise=null;
const statusMeta={
  yes:{label:'Есть бензин',short:'есть',cls:'s-green',color:'#20a464',rank:1},
  queue:{label:'Есть, но очередь',short:'очередь',cls:'s-orange',color:'#f59e0b',rank:3},
  low:{label:'Мало бензина',short:'мало',cls:'s-yellow',color:'#eab308',rank:4},
  no:{label:'Нет бензина',short:'нет',cls:'s-red',color:'#e5484d',rank:5},
  unknown:{label:'Нет данных',short:'нет данных',cls:'s-gray',color:'#6b7280',rank:2}
};
function norm(v){return (v??'').toString().trim()}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function num(v){const n=parseFloat(String(v??'').replace(',','.')); return Number.isFinite(n)?n:0}
function intVal(v){const n=parseInt(String(v??'').replace(/[^\d-]/g,''),10); return Number.isFinite(n)?n:0}
function detectStatus(row){
  const code=norm(row.status_code).toLowerCase();
  if(['yes','queue','low','no'].includes(code)) return code;
  const text=norm(row.status).toLowerCase();
  if(text.includes('очеред')) return 'queue';
  if(text.includes('мало')||text.includes('низ')) return 'low';
  if(text.includes('нет')) return 'no';
  if(text.includes('есть')) return 'yes';
  return 'unknown';
}
function normalizeRow(row){
  const out={};
  expectedFields.forEach(f=>out[f]=norm(row[f]));
  if(!out.station_name && row.name) out.station_name=norm(row.name);
  out.brand=out.station_name;
  out.status_code=detectStatus(out);
  out.status=statusMeta[out.status_code].label;
  out.confirmations=intVal(out.confirmations);
  out.realCount=intVal(out.realCount);
  fuelColumns.forEach(f=>out[f]=norm(out[f])==='1'?'1':'');
  if(!fuelColumns.some(f=>out[f]==='1') && out.fuels_now){
    const t=out.fuels_now.toUpperCase().replaceAll('АИ-','').replaceAll('ДИЗЕЛЬ','ДТ');
    fuelColumns.forEach(f=>{ if(t.includes(f)) out[f]='1'; });
  }
  return out;
}
function parseCSV(text){
  text=text.replace(/^\uFEFF/,'').replace(/\r/g,'');
  const lines=text.split('\n').filter(line=>line.trim());
  if(!lines.length) return [];
  const delim=(lines[0].split(';').length>lines[0].split(',').length)?';':',';
  const split=(line)=>{
    const out=[]; let cur=''; let q=false;
    for(let i=0;i<line.length;i++){
      const c=line[i], next=line[i+1];
      if(c==='"' && q && next==='"'){cur+='"'; i++; continue}
      if(c==='"'){q=!q; continue}
      if(c===delim && !q){out.push(cur); cur=''; continue}
      cur+=c;
    }
    out.push(cur);
    return out.map(x=>x.trim());
  };
  const head=split(lines[0]).map(h=>h.trim());
  return lines.slice(1).map(line=>{
    const vals=split(line); const row={};
    head.forEach((h,i)=>row[h]=vals[i]??'');
    return normalizeRow(row);
  }).filter(row=>row.station_name||row.osm_id||row.lat);
}
function parseFileText(text,name){
  if(name.toLowerCase().endsWith('.json') || text.trim().startsWith('[')){
    const rows=JSON.parse(text);
    return rows.map(normalizeRow);
  }
  return parseCSV(text);
}
function setOptions(id,values,mapper=x=>x){
  const el=document.getElementById(id); if(!el) return;
  const first=el.options[0].outerHTML;
  const opts=[...new Set(values.map(mapper).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),'ru'));
  el.innerHTML=first+opts.map(v=>`<option>${esc(v)}</option>`).join('');
}
function syncFilters(){
  ['statusFilter','statusFilter2','statusFilterMap'].forEach(id=>setOptions(id,data.map(d=>statusMeta[d.status_code].label)));
  ['fuelFilter','fuelFilter2','fuelFilterMap'].forEach(id=>setOptions(id,data.flatMap(d=>fuelColumns.filter(f=>d[f]==='1'))));
  ['brandFilter','brandFilter2','brandFilterMap'].forEach(id=>setOptions(id,data.map(d=>d.brand||'Без бренда')));
  ['districtFilter','districtFilter2','districtFilterMap'].forEach(id=>setOptions(id,data.map(d=>d.district)));
  ['regionFilter','regionFilterMap'].forEach(id=>setOptions(id,data.map(d=>d.region)));
}
function getVal(id){return norm(document.getElementById(id)?.value)}
const filterGroups=[
  ['q','q2','qMap'],
  ['statusFilter','statusFilter2','statusFilterMap'],
  ['fuelFilter','fuelFilter2','fuelFilterMap'],
  ['brandFilter','brandFilter2','brandFilterMap'],
  ['districtFilter','districtFilter2','districtFilterMap'],
  ['regionFilter','regionFilterMap']
];
function groupVal(ids){return ids.map(getVal).find(Boolean)||''}
function syncFilterGroup(changedId){
  const group=filterGroups.find(ids=>ids.includes(changedId));
  if(!group) return;
  const value=getVal(changedId);
  group.forEach(id=>{
    if(id===changedId) return;
    const el=document.getElementById(id);
    if(el && el.value!==value) el.value=value;
  });
}
function applyFilters(){
  const q=groupVal(['q','q2','qMap']).toLowerCase();
  const st=groupVal(['statusFilter','statusFilter2','statusFilterMap']);
  const fuel=groupVal(['fuelFilter','fuelFilter2','fuelFilterMap']);
  const brand=groupVal(['brandFilter','brandFilter2','brandFilterMap']);
  const district=groupVal(['districtFilter','districtFilter2','districtFilterMap']);
  const region=groupVal(['regionFilter','regionFilterMap']);
  filtered=data.filter(d=>{
    const hay=[d.station_name,d.brand,d.region,d.district,d.osm_id,d.fuels_now,d.status].join(' ').toLowerCase();
    return (!q||hay.includes(q)) &&
      (!st||statusMeta[d.status_code].label===st) &&
      (!fuel||d[fuel]==='1') &&
      (!brand||(d.brand||'Без бренда')===brand) &&
      (!district||d.district===district) &&
      (!region||d.region===region);
  });
  render();
}
function hasActiveFilters(){
  return filterGroups.some(ids=>Boolean(groupVal(ids)));
}
function statusPill(code){const m=statusMeta[code]||statusMeta.unknown; return `<span class="pill ${m.cls}">${m.label}</span>`}
function countStatus(code){return filtered.filter(d=>d.status_code===code).length}
function renderKPIs(){
  document.getElementById('kpiTotal').textContent=filtered.length;
  document.getElementById('kpiOk').textContent=countStatus('yes');
  document.getElementById('kpiQueue').textContent=countStatus('queue');
  document.getElementById('kpiLow').textContent=countStatus('low');
  document.getElementById('kpiEmpty').textContent=countStatus('no');
  document.getElementById('kpiMarks').textContent=filtered.reduce((s,d)=>s+d.realCount,0);
}
function renderStatusBars(){
  const total=Math.max(filtered.length,1);
  const order=['yes','queue','low','no','unknown'];
  document.getElementById('statusBars').innerHTML=order.map(code=>{
    const m=statusMeta[code], n=countStatus(code), pct=Math.round(n/total*100);
    return `<div style="margin:12px 0"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>${m.label}</b><span>${n} / ${pct}%</span></div><div class="bar"><span style="width:${pct}%;background:${m.color}"></span></div></div>`;
  }).join('');
}
function renderFuelBars(){
  const max=Math.max(...fuelColumns.map(f=>filtered.filter(d=>d[f]==='1').length),1);
  document.getElementById('fuelBars').innerHTML=fuelColumns.map(f=>{
    const n=filtered.filter(d=>d[f]==='1').length, pct=Math.round(n/max*100);
    return `<div style="margin:12px 0"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>${f}</b><span>${n}</span></div><div class="bar"><span style="width:${pct}%;background:var(--blue)"></span></div></div>`;
  }).join('');
}
function topRows(keyFn,valueFn,limit=10){
  const map=new Map();
  filtered.forEach(d=>{
    const key=keyFn(d)||'Не указано';
    const v=map.get(key)||{total:0,problem:0,marks:0};
    v.total++; v.marks+=d.realCount; if(['queue','low','no'].includes(d.status_code)) v.problem++;
    map.set(key,v);
  });
  return [...map.entries()].sort((a,b)=>valueFn(b[1])-valueFn(a[1]) || b[1].total-a[1].total).slice(0,limit);
}
function renderMetricBars(id,rows,valueFn,colorFn,labelFn){
  const max=Math.max(...rows.map(([,v])=>valueFn(v)),1);
  document.getElementById(id).innerHTML=rows.map(([k,v])=>{
    const n=valueFn(v), pct=Math.round(n/max*100);
    return `<div style="margin:12px 0"><div style="display:flex;justify-content:space-between;margin-bottom:6px"><b>${esc(k)}</b><span>${labelFn(v)}</span></div><div class="bar"><span style="width:${pct}%;background:${colorFn(v)}"></span></div><div class="source">всего: ${v.total}, проблемных: ${v.problem}, отметок 24ч: ${v.marks}</div></div>`;
  }).join('') || '<p class="muted">Нет данных.</p>';
}
function renderGroups(){
  renderMetricBars('districtBars', topRows(d=>d.district,v=>v.problem,14), v=>v.problem, v=>v.problem?statusMeta.no.color:'#cbd5e1', v=>`проблемных: ${v.problem}`);
  renderMetricBars('districtActivityBars', topRows(d=>d.district,v=>v.marks,14), v=>v.marks, v=>'var(--blue)', v=>`отметок: ${v.marks}`);
  renderMetricBars('activityBars', topRows(d=>d.district,v=>v.marks,8), v=>v.marks, v=>'var(--blue)', v=>`${v.marks}`);
  renderMetricBars('brandBars', topRows(d=>d.brand||'Без бренда',v=>v.total,8), v=>v.total, v=>'#64748b', v=>`${v.total}`);
}
function renderSummary(){
  const n=filtered.length, bad=countStatus('no'), queue=countStatus('queue'), low=countStatus('low'), problem=bad+queue+low;
  let cls='ok', title='Критичных сигналов нет', text='В текущей выборке нет красных, жёлтых или оранжевых статусов.';
  if(n===0){cls='warn'; title='Нет загруженных данных'; text='Загрузите CSV/JSON во вкладке “Загрузка данных”.'}
  else if(bad>0 || problem/n>.35){cls='crit'; title='Требуется оперативная проверка'; text=`Проблемные статусы у ${problem} из ${n} АЗС. Красных точек: ${bad}, очередей: ${queue}, низких остатков: ${low}.`;}
  else if(problem>0){cls='warn'; title='Ситуация требует мониторинга'; text=`Есть ${problem} проблемных сигналов. Приоритет — свежие отметки с высоким realCount.`;}
  document.getElementById('executiveSummary').innerHTML=`<div class="decision ${cls}"><h3>${title}</h3><div>${text}</div></div><p class="muted">Суммарно отметок водителей за 24 часа: <b>${filtered.reduce((s,d)=>s+d.realCount,0)}</b>. Подтверждений: <b>${filtered.reduce((s,d)=>s+d.confirmations,0)}</b>.</p>`;
}
function fuelText(d){
  const fuels=fuelColumns.filter(f=>d[f]==='1');
  return fuels.length?fuels.join(', '):(d.fuels_now||'—');
}
function renderTable(){
  const body=document.querySelector('#azsTable tbody');
  body.innerHTML=filtered.map((d,i)=>`<tr><td>${i+1}</td><td><b>${esc(d.station_name)||'—'}</b><div class="source">${esc(d.osm_id)}</div></td><td>${esc(d.brand)||'—'}</td><td>${esc(d.region)||'—'}</td><td>${esc(d.district)||'—'}</td><td>${esc(fuelText(d))}</td><td>${statusPill(d.status_code)}</td><td>${d.confirmations}</td><td>${d.realCount}</td><td>${esc(d.last_at)||'—'}</td><td>${esc(d.lat)}, ${esc(d.lon)}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">Нет данных.</td></tr>';
}
function decisionRow(d,cls='warn'){
  return `<div class="decision ${cls}"><b>${esc(d.station_name)||'АЗС'}</b><br><span class="muted">${esc(d.brand)||'—'} · ${esc(d.region)} · ${esc(d.district)}</span><br>${statusPill(d.status_code)} <span class="pill s-blue">${d.realCount} отметок 24ч</span> <span class="pill s-gray">${d.confirmations} подтв.</span></div>`;
}
function renderDecisions(){
  const critical=[...filtered].filter(d=>['no','low'].includes(d.status_code)).sort((a,b)=>b.realCount-a.realCount || statusMeta[b.status_code].rank-statusMeta[a.status_code].rank).slice(0,8);
  const queues=[...filtered].filter(d=>d.status_code==='queue').sort((a,b)=>b.realCount-a.realCount).slice(0,8);
  const fresh=[...filtered].filter(d=>d.realCount>0).sort((a,b)=>b.realCount-a.realCount).slice(0,8);
  document.getElementById('checkList').innerHTML=critical.map(d=>decisionRow(d,d.status_code==='no'?'crit':'warn')).join('')||'<p class="muted">Критичных точек нет.</p>';
  document.getElementById('queueList').innerHTML=queues.map(d=>decisionRow(d,'warn')).join('')||'<p class="muted">Очередей нет.</p>';
  document.getElementById('freshList').innerHTML=fresh.map(d=>decisionRow(d,['no','low','queue'].includes(d.status_code)?'warn':'ok')).join('')||'<p class="muted">Свежих отметок нет.</p>';
}
function initMap(){
  if(map) return Promise.resolve(map);
  if(mapReadyPromise) return mapReadyPromise;
  if(typeof ymaps==='undefined'){
    document.getElementById('mapInfo').innerHTML='Яндекс.Карты не загрузились. Проверьте доступ к интернету или ключ API, если он требуется в вашей среде.';
    return Promise.resolve(null);
  }
  mapReadyPromise=new Promise(resolve=>{
    ymaps.ready(()=>{
      map=new ymaps.Map('map',{center:defaultMapCenter,zoom:defaultMapZoom,controls:['zoomControl','fullscreenControl','typeSelector']},{suppressMapOpenBlock:true});
      resolve(map);
    });
  });
  return mapReadyPromise;
}
async function renderMap(){
  const ym=await initMap();
  if(!ym) return;
  markers.forEach(m=>ym.geoObjects.remove(m)); markers=[];
  const pts=[];
  filtered.forEach(d=>{
    const lat=num(d.lat), lon=num(d.lon); if(!lat||!lon) return;
    const meta=statusMeta[d.status_code]||statusMeta.unknown;
    const marker=new ymaps.Placemark([lat,lon],{
      hintContent: `${d.station_name || 'АЗС'} · ${statusMeta[d.status_code]?.label || ''}`,
      balloonContent: `<b>${esc(d.station_name)}</b><br>${esc(d.brand)||'—'}<br>${esc(d.region)} · ${esc(d.district)}<br>${statusPill(d.status_code)}<br>Топливо: ${esc(fuelText(d))}<br>Подтверждения: ${d.confirmations}<br>Отметки 24ч: ${d.realCount}<br>${esc(d.last_at)||''}`
    },{
      preset:'islands#circleIcon',
      iconColor:meta.color
    });
    ym.geoObjects.add(marker);
    markers.push(marker);
    pts.push([lat,lon]);
  });
  if(pts.length && hasActiveFilters()){
    ym.setBounds(ymaps.util.bounds.fromPoints(pts),{checkZoomRange:true,zoomMargin:30});
  }else{
    ym.setCenter(defaultMapCenter,defaultMapZoom,{duration:0});
  }
  document.getElementById('mapInfo').innerHTML=pts.length?`На карте отображено точек: <b>${pts.length}</b>`:'Нет координат в текущей выборке.';
}
function render(){
  renderKPIs(); renderStatusBars(); renderFuelBars(); renderGroups(); renderSummary(); renderTable(); renderDecisions();
  setTimeout(renderMap,80);
}
function loadData(rows,source){
  data=rows.map(normalizeRow);
  filtered=[...data];
  syncFilters(); applyFilters();
  document.getElementById('refreshLabel').textContent=`Загружено: ${data.length}`;
  document.getElementById('importStatus').innerHTML=`<div class="decision ok"><h3>Файл загружен</h3><div>${esc(source)} · строк: <b>${data.length}</b></div></div>`;
}
async function loadDefault(){
  try{
    const res=await fetch('gdebenz_unified_status_realcount_districts.csv',{cache:'no-store'});
    if(!res.ok) throw new Error('HTTP '+res.status);
    loadData(parseCSV(await res.text()),'gdebenz_unified_status_realcount_districts.csv');
  }catch(e){
    document.getElementById('importStatus').innerHTML=`<div class="decision warn"><h3>Не удалось загрузить из папки</h3><div>Выберите CSV через кнопку выбора файла.</div></div>`;
  }
}
function exportCSV(){
  const fields=expectedFields;
  const rows=[fields.join(',')].concat(filtered.map(d=>fields.map(f=>`"${String(d[f]??'').replaceAll('"','""')}"`).join(',')));
  const blob=new Blob(['\uFEFF'+rows.join('\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='gdebenz_filtered.csv'; a.click(); URL.revokeObjectURL(a.href);
}
document.querySelectorAll('.tab').forEach(btn=>btn.onclick=()=>{
  document.querySelectorAll('.tab,.view').forEach(el=>el.classList.remove('active'));
  btn.classList.add('active'); document.getElementById(btn.dataset.tab).classList.add('active');
  setTimeout(()=>{ if(map) map.container.fitToViewport(); },120);
});
['q','q2','qMap','statusFilter','statusFilter2','statusFilterMap','fuelFilter','fuelFilter2','fuelFilterMap','brandFilter','brandFilter2','brandFilterMap','districtFilter','districtFilter2','districtFilterMap','regionFilter','regionFilterMap'].forEach(id=>document.getElementById(id)?.addEventListener('input',()=>{syncFilterGroup(id);applyFilters();}));
document.getElementById('fileInput').addEventListener('change',event=>{
  const file=event.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=()=>{try{loadData(parseFileText(String(reader.result),file.name),file.name)}catch(e){document.getElementById('importStatus').innerHTML=`<div class="decision crit"><h3>Ошибка импорта</h3><div>${esc(e.message)}</div></div>`}};
  reader.readAsText(file,'utf-8');
});
document.getElementById('loadDefaultBtn').onclick=loadDefault;
document.getElementById('clearBtn').onclick=()=>loadData([],'очищено');
document.getElementById('exportBtn').onclick=exportCSV;
render();
