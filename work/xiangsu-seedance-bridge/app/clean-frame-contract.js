'use strict';
const LOCK='No graphic overlays or non-diegetic writing; retain source-authored physical marks.';
function hasLock(prompt){return String(prompt).includes(LOCK.slice(0,-1))||/only photographed story-world content and no generated writing or graphic overlay/i.test(String(prompt));}
module.exports={LOCK,hasLock};
