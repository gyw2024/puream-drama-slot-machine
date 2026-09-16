'use strict';
// Escape literal JSON control characters only inside a closed string. This
// preserves their decoded value; it cannot invent a field or finish a response.
function escapeControls(source){
 let quoted=false,escaped=false,out='';
 for(const c of String(source||'')){
  if(quoted){
   if(escaped){out+=c;escaped=false;continue;}
   if(c==='\\'){out+=c;escaped=true;continue;}
   if(c==='"')quoted=false;
   if(c.charCodeAt(0)<32){out+='\\u'+c.charCodeAt(0).toString(16).padStart(4,'0');continue;}
  }else if(c==='"')quoted=true;
  out+=c;
 }
 return quoted||escaped?source:out;
}
module.exports={escapeControls};
