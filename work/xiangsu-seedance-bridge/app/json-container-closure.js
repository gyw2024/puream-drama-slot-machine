'use strict';
// Recover only omitted OUTER closing delimiters after a complete container.
// Never invent a string, primitive value, field, array item, or punctuation.
function close(text){
 const raw=String(text||'').trim();try{JSON.parse(raw);return null;}catch{}
 if(!/^[{[]/.test(raw)||!/[}\]]$/.test(raw))return null;
 const stack=[];let quoted=false,escaped=false;
 for(const c of raw){if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')stack.push(c);
  else if(c==='}'||c===']'){if(stack.pop()!==(c==='}'?'{':'['))return null;}
 }
 if(quoted||!stack.length)return null;
 const appended=stack.reverse().map(c=>c==='{'?'}':']').join(''),normalized=raw+appended;
 try{JSON.parse(normalized);return {text:normalized,appended};}catch{return null;}
}
module.exports={close};
