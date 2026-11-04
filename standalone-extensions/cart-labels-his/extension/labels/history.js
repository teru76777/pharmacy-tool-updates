const HISTORY_KEY='cart-label-print-history-v1';
const DAY_MS=86400000;
const KEEP_DAYS=14; // 紀錄保留天數（連假時仍找得到前前次列印）
let historyAvailable=true,printJob=null,printBusy=false;
function taiwanDay(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
function dayAge(day,today=taiwanDay()){return (Date.parse(today+'T00:00:00Z')-Date.parse(day+'T00:00:00Z'))/DAY_MS;}
// 記憶只存病歷號：標籤第三行為「病歷號 生日」時只取第一段（帳號版標籤為帳號）；不存姓名、生日
function chartId(value){
 const t=(String(value||'').trim().toUpperCase().split(/\s+/)[0])||'';
 return t.length>=6&&!/^\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}$/.test(t)?t:'';
}
function labelIdentity(text){
 const lines=text.split('\n'),parts=(lines[0]||'').split('  ');
 const ward=parts.shift().trim(),bed=parts.join('  ').trim(),account=chartId(lines[2]);
 return ward&&bed&&account?{ward,bed,account}:null;
}
function identityKey(value){return JSON.stringify([wardKey(value.ward),bedKey(value.bed),value.account]);}
function retainedHistory(rows,today=taiwanDay()){
 if(!Array.isArray(rows))return [];
 return rows.flatMap(r=>{
  if(!r||typeof r.ward!=='string'||typeof r.bed!=='string'||typeof r.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!(dayAge(r.day,today)>=0&&dayAge(r.day,today)<KEEP_DAYS))return [];
  const base={ward:r.ward,bed:r.bed,day:r.day};
  if(r.vacant===true)return [{...base,vacant:true}]; // 空床：只記病房、床號、日期
  // 舊紀錄的「病歷號 生日」自動去掉生日；舊版末五碼紀錄無法比對，直接移除
  const account=typeof r.account==='string'?chartId(r.account):'';
  return account?[{...base,account}]:[];
 });
}
function readHistory(){
 try{const raw=localStorage.getItem(HISTORY_KEY);let parsed;try{parsed=JSON.parse(raw||'[]');}catch{parsed=[];}const rows=retainedHistory(parsed);if(raw!==JSON.stringify(rows)){localStorage.setItem(HISTORY_KEY,JSON.stringify(rows));if(raw&&typeof memoryFileChanged==='function')memoryFileChanged();}historyAvailable=true;return rows;}catch{historyAvailable=false;return [];}
}
// 比對日＝今天以前「前前一次」有列印的日期（兩台藥車依列印輪流；週末、連假沒印的日子不算）
function printDays(history,today=taiwanDay()){
 return [...new Set(retainedHistory(history,today).filter(r=>dayAge(r.day,today)>0).map(r=>r.day))].sort().reverse();
}
function comparisonDay(history,today=taiwanDay()){return printDays(history,today)[1]||null;}
function comparisonHistory(history,today=taiwanDay()){
 const byAccount=new Map(),day=comparisonDay(history,today);
 for(const row of retainedHistory(history,today)){
  if(day&&row.account&&row.day===day)byAccount.set(row.account,row);
 }
 return [...byAccount.values()];
}
// 前前次列印印過空床標籤的床位
function vacantKey(ward,bed){return wardKey(ward)+'|'+bedKey(bed);}
function comparisonVacancies(history,today=taiwanDay()){
 return new Set(retainedHistory(history,today).filter(r=>r.vacant&&r.day===comparisonDay(history,today)).map(r=>vacantKey(r.ward,r.bed)));
}
// 前前次也是空床的床位；以下仍照常印、不詢問：
// 1. 今天因出院排除而變空床（今日可出院）  2. 前前次之後（含前前次）曾印過病人標籤的床位（本來有人、今天變空床）
function findVacantRepeats(texts,history,today=taiwanDay()){
 const keys=comparisonVacancies(history,today),day=comparisonDay(history,today);
 const hadPatient=new Set(retainedHistory(history,today).filter(r=>r.account&&day&&r.day>=day&&dayAge(r.day,today)>0).map(r=>vacantKey(r.ward,r.bed)));
 return texts.flatMap((text,index)=>{
  if(!isVacantLabel(text))return [];
  const {ward,bed}=labelBed(text),key=vacantKey(ward,bed);
  if(!keys.has(key)||hadPatient.has(key)||(typeof vacantCaptions!=='undefined'&&vacantCaptions.has(key)))return [];
  return [{ward,bed,index}];
 });
}
// 預覽「略過已印」：略過前前次已印的病人（轉床除外）與前前次也是空床的床位，與列印時的結果相同
let filterCache=null;
function previewFilterOn(){return !!$('previewFiltered')?.checked;}
function filteredView(){
 if(!previewFilterOn()||!records.length)return null;
 let raw='';try{raw=localStorage.getItem(HISTORY_KEY)||'';}catch{}
 const today=taiwanDay(),key=raw+'|'+today+'|'+recordsUsePresets+'|'+[...vacantCaptions.keys()].join(',');
 if(filterCache&&filterCache.records===records&&filterCache.key===key)return filterCache.view;
 let history=[];try{history=retainedHistory(JSON.parse(raw||'[]'),today);}catch{}
 const moved=new Set(findTransfers(records,history,today).map(t=>t.index));
 const skipped=new Set(findDuplicates(records,history,today).filter(d=>!moved.has(d.index)).map(d=>d.index));
 const drop=new Set(findVacantRepeats(records,history,today).map(d=>d.index));
 // 略過的病人與前前次也是空床的床位都保留原格位（標示 SKIP），後面的床位不前移
 const view=recordsUsePresets?{list:records,omitted:new Set([...skipped,...drop])}:{list:records.filter((_,i)=>!skipped.has(i)&&!drop.has(i)),omitted:new Set()};
 view.hidden={dup:skipped.size,vacant:drop.size};
 filterCache={records,key,view};return view;
}
function filterInfoText(){
 if(!previewFilterOn())return '';
 const v=filteredView();if(!v)return '';
 return v.hidden.dup||v.hidden.vacant?`已略過：前前次已印 ${v.hidden.dup} 位、前前次也是空床 ${v.hidden.vacant} 床。`:'沒有需要略過的標籤。';
}
function chooseVacantRepeats(repeats){
 return new Promise(resolve=>{
  const dialog=$('vacantRepeatDialog');$('vacantRepeatList').replaceChildren();
  $('vacantRepeatSummary').textContent=`本次有 ${repeats.length} 個空床，前前次列印（${comparisonDay(readHistory())}）也是空床。`;
  const choices=repeats.map(d=>{const row=document.createElement('label');row.className='duplicate-row';const check=document.createElement('input');check.type='checkbox';check.checked=true;const text=document.createElement('span');text.textContent=`${d.ward}　${d.bed}　空床`;row.append(check,text);$('vacantRepeatList').append(row);return {index:d.index,check};});
  const finish=value=>{dialog.oncancel=null;dialog.close();resolve(value);};
  $('vacantRepeatCancel').onclick=()=>finish(null);$('vacantRepeatSkip').onclick=()=>finish(new Set(repeats.map(d=>d.index)));$('vacantRepeatContinue').onclick=()=>finish(new Set(choices.filter(c=>!c.check.checked).map(c=>c.index)));dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();
 });
}
function updateMemoryStatus(){
 const rows=readHistory(),today=taiwanDay(),comparison=comparisonHistory(rows,today);
 $('memoryStatus').textContent=historyAvailable?(()=>{const days=printDays(rows,today),day=days[1];return day?`比對前前次列印（${day}${dayAge(day,today)!==2?'，'+dayAge(day,today)+' 天前':''}）：病人 ${comparison.length} 筆、空床 ${comparisonVacancies(rows,today).size} 床。`:`今天以前${days.length?'只有 1 天（'+days[0]+'）':'沒有'}列印紀錄，需有兩次不同日期的列印才會比對，本次不提醒重複、轉床或空床。`;})():'此瀏覽器無法儲存記憶；仍可列印，但無法提醒過去已印的標籤。';
 return rows;
}
function findDuplicates(texts,history,today=taiwanDay()){
 const keys=new Set(comparisonHistory(history,today).map(identityKey));
 return texts.flatMap((text,index)=>{const id=labelIdentity(text);return id&&keys.has(identityKey(id))?[{...id,index}]:[];});
}
function chooseDuplicates(duplicates,total){
 return new Promise(resolve=>{
  const dialog=$('duplicateDialog');$('duplicateList').replaceChildren();
  $('duplicateSummary').textContent=`本次 ${total} 張病人標籤中，有 ${duplicates.length} 張與前前次列印（${comparisonDay(readHistory())}）相同。`;
  const choices=duplicates.map(d=>{const row=document.createElement('label');row.className='duplicate-row';const check=document.createElement('input');check.type='checkbox';check.checked=true;const text=document.createElement('span');text.textContent=`${d.ward}　${d.bed}　病歷號 ${d.account}`;row.append(check,text);$('duplicateList').append(row);return {index:d.index,check};});
  const finish=value=>{dialog.oncancel=null;dialog.close();resolve(value);};
  $('duplicateCancel').onclick=()=>finish(null);$('duplicateSkip').onclick=()=>finish(new Set(duplicates.map(d=>d.index)));$('duplicateContinue').onclick=()=>finish(new Set(choices.filter(c=>!c.check.checked).map(c=>c.index)));dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();
 });
}
function findTransfers(texts,history,today=taiwanDay()){
 const latest=new Map(comparisonHistory(history,today).map(row=>[row.account,row]));
 return texts.flatMap((text,index)=>{
  const id=labelIdentity(text),previous=id&&latest.get(id.account);
  return previous&&(wardKey(id.ward)!==wardKey(previous.ward)||bedKey(id.bed)!==bedKey(previous.bed))?[{...id,index,previous}]:[];
 });
}
function confirmTransfers(transfers){
 return new Promise(resolve=>{
  const dialog=$('transferDialog');$('transferList').replaceChildren();
  $('transferSummary').textContent=`${transfers.length} 張標籤的床位與前前次列印的紀錄不同，請確認轉床資料。`;
  for(const t of transfers){
   const row=document.createElement('div');row.className='transfer-row';
   const account=document.createElement('strong');account.textContent=`病歷號 ${t.account}`;
   const route=document.createElement('div');route.textContent=`${t.previous.ward}　${t.previous.bed} → ${t.ward}　${t.bed}`;
   const date=document.createElement('small');date.textContent=`前前次列印紀錄：${t.previous.day}`;
   row.append(account,route,date);$('transferList').append(row);
  }
  const finish=value=>{dialog.oncancel=null;dialog.close();resolve(value);};
  $('transferCancel').onclick=()=>finish(false);$('transferContinue').onclick=()=>finish(true);
  dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();
 });
}
function clearPrintHistory(){
 if(printBusy)return;
 try{localStorage.removeItem(HISTORY_KEY);historyAvailable=true;updateMemoryStatus();$('status').textContent='已清除所有列印記憶，字體與字級設定保留。';if(typeof memorySync==='function')memorySync({write:true,pull:false,gesture:true}).then(r=>{if(r?.wrote)$('status').textContent+=' 列印記憶.txt 已一併清空。';});}
 catch{$('status').textContent='無法清除列印記憶，請再試一次。';}
 $('clearMemoryDialog').close();
}
$('clearMemory').onclick=()=>{if(!printBusy)$('clearMemoryDialog').showModal();};
$('clearMemoryCancel').onclick=()=>$('clearMemoryDialog').close();
$('clearMemoryConfirm').onclick=clearPrintHistory;
async function beginRememberedPrint(){
 if(printBusy||$('print').disabled)return;
 printBusy=true;
 try{
  if(typeof memorySync==='function')await memorySync({gesture:true}); // 先套用 列印記憶.txt 的手動修改
  const sourceSnapshot=[...records],history=updateMemoryStatus(),today=taiwanDay();
  const transfers=findTransfers(sourceSnapshot,history,today);
  if(transfers.length&&!await confirmTransfers(transfers)){printBusy=false;return;}
  const moved=new Set(transfers.map(t=>t.index));
  const duplicates=findDuplicates(sourceSnapshot,history,today).filter(d=>!moved.has(d.index));
  // 預覽「略過已印」開啟時：照預覽直接略過，不再逐一詢問
  const auto=previewFilterOn();
  const skipped=duplicates.length?(auto?new Set(duplicates.map(d=>d.index)):await chooseDuplicates(duplicates,sourceSnapshot.filter(text=>!isVacantLabel(text)).length)):new Set();
  if(skipped===null){printBusy=false;return;}
  // 前前次列印也是空床：詢問還要不要空白貼紙；不印的直接移除（不占格位）
  const repeats=findVacantRepeats(sourceSnapshot,history,today);
  const dropVacant=repeats.length?(auto?new Set(repeats.map(d=>d.index)):await chooseVacantRepeats(repeats)):new Set();
  if(dropVacant===null){printBusy=false;return;}
  // 不印的（已印病人、前前次也是空床）保留原格位並標示 SKIP，後面的床位不前移
  const omit=new Set([...skipped,...dropVacant]);
  const selected=sourceSnapshot.filter((_,i)=>!omit.has(i));
  printOmitted=recordsUsePresets?omit:new Set();
  printSelection=recordsUsePresets?sourceSnapshot:selected;current=0;render();
  if(!selected.length){printSelection=null;printOmitted=new Set();render();$('status').textContent='已略過全部已印標籤，本次無需列印。';printBusy=false;return;}
  if(document.fonts)await document.fonts.ready;
  render();if($('print').disabled){printSelection=null;printOmitted=new Set();render();printBusy=false;return;}
  const copies=t=>typeof labelCopies==='function'?labelCopies(t):1;
  printJob={identities:sourceSnapshot.map(labelIdentity).filter(Boolean),vacantBeds:sourceSnapshot.filter(isVacantLabel).map(t=>{const {ward,bed}=labelBed(t);return {ward,bed};}),count:selected.filter(text=>!isVacantLabel(text)).reduce((n,t)=>n+copies(t),0),vacancies:selected.filter(isVacantLabel).reduce((n,t)=>n+copies(t),0),dropped:dropVacant.size,patients:sourceSnapshot.filter(text=>!isVacantLabel(text)).length,day:taiwanDay(),prompted:false};
  updatePrintStamps();window.print();
 }catch(error){printSelection=null;printOmitted=new Set();printJob=null;printBusy=false;render();$('status').textContent='無法開啟列印，請再試一次。';}
}
window.addEventListener('afterprint',()=>{
 if(!printJob||printJob.prompted)return;
 printJob.prompted=true;
 setTimeout(()=>{if(!printJob)return;$('completeSummary').textContent=`本次列印 ${printJob.count} 張病人標籤、${printJob.vacancies} 張空床標籤${printJob.dropped?`（另有 ${printJob.dropped} 個前前次也是空床的床位未印）`:''}。空床只記錄病房與床號。`;$('completeDialog').showModal();},0);
});
async function finishRememberedPrint(completed){
 const job=printJob;if(!job||job.finishing)return;
 job.finishing=true;
 let saved=false,fileNote='';
 if(completed){
  if(typeof memorySync==='function')await memorySync({gesture:true}); // 先讀回 TXT 的修改，再加入本次紀錄
  const rows=readHistory();
  if(historyAvailable)try{
   const merged=new Map(rows.map(r=>[r.vacant?r.day+'|V|'+vacantKey(r.ward,r.bed):r.account?r.day+'|'+r.account:'legacy|'+JSON.stringify(r),r]));
   for(const id of job.identities){const entry={...id,day:job.day};merged.set(entry.day+'|'+entry.account,entry);}
   for(const v of job.vacantBeds||[]){const entry={ward:v.ward,bed:v.bed,day:job.day,vacant:true};merged.set(entry.day+'|V|'+vacantKey(v.ward,v.bed),entry);}
   localStorage.setItem(HISTORY_KEY,JSON.stringify(retainedHistory([...merged.values()])));saved=true;
  }catch{historyAvailable=false;}
  if(saved&&typeof memorySync==='function'){const r=await memorySync({write:true,pull:false,gesture:true});fileNote=r?.wrote?' 已更新 列印記憶.txt。':r?.linked?(typeof memBlocked!=='undefined'&&memBlocked?' 列印記憶.txt 有格式錯誤，未更新（見 ⚙ 設定 → 列印記憶）。':' 列印記憶.txt 未更新（需要允許，見 ⚙ 設定 → 列印記憶）。'):'';}
 }
 $('completeDialog').close();printSelection=null;printOmitted=new Set();printJob=null;printBusy=false;render();updateMemoryStatus();
 $('status').textContent=completed?(saved?`已記錄本次列印（病人：病房、床號、病歷號與日期；空床：病房、床號與日期；不含姓名、生日）。${(job.patients??job.count)-job.identities.length?'部分標籤缺少病歷號，未記入記憶。':''}${fileNote}`:'已完成列印，但瀏覽器無法儲存紀錄。'):'本次未寫入列印記憶。';
 if(saved&&typeof memTxtLink==='function')$('status').append(' ',memTxtLink());
}
$('completeYes').onclick=()=>finishRememberedPrint(true);$('completeNo').onclick=()=>finishRememberedPrint(false);$('completeDialog').oncancel=e=>{e.preventDefault();finishRememberedPrint(false);};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')updateMemoryStatus();});
window.addEventListener('storage',event=>{if(event.key===HISTORY_KEY||event.key===null)updateMemoryStatus();});
setInterval(updateMemoryStatus,3600000);updateMemoryStatus();
