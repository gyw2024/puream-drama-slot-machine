(function(root){
 'use strict';
 root.createProjectLogExport=function({button,getProjectId,exportLogs,notify}){
  if(!button)return;let busy=false;
  button.addEventListener('click',async event=>{
   event.stopPropagation();
   if(busy)return;const id=getProjectId();if(!id)return notify('请先选择一个项目','error');
   busy=true;button.disabled=true;button.setAttribute('aria-busy','true');const label=button.querySelector('b'),original=label?.textContent;if(label)label.textContent='正在导出…';
   try{const result=await exportLogs(id);if(result?.canceled)return;if(!result?.ok)throw Error(result?.message||'导出失败');notify(`运行日志已导出（${result.result.files}个文件）。请把保存的 ZIP 诊断包发给排查人员。`);}
   catch(e){notify(e.message||'导出运行日志失败','error');}
   finally{busy=false;button.disabled=false;button.removeAttribute('aria-busy');if(label)label.textContent=original;}
  });
 };
})(window);
