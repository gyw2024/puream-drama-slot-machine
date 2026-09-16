"use strict";
const fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"../.codex_tests/TASK-20260905-PERFORMANCE-TIMELINE/videos");
const audio=JSON.parse(fs.readFileSync(path.join(root,"audio-screening.json"),"utf8"));
const videos=JSON.parse(fs.readFileSync(path.join(root,"video-audit.json"),"utf8"));
const visuallyClear=new Set("S01 S04 S06 S07 S08 S13 S20 S21 S22 S26 S28 S34 S36 S40 S42".split(" "));
const confirmed={S17:"跪下后约6秒切回站姿",S25:"应落座，抽样全程站姿"};
const rows=audio.records.map(r=>{
 const v=videos.records.find(v=>v.shotId===r.shotId);
 const end=r.segments.at(-1)?.end;
 const tail=Number((v.actualDuration-end).toFixed(2));
 return {...r,actualDuration:v.actualDuration,estimatedTail:tail,visualReview:confirmed[r.shotId]|| (visuallyClear.has(r.shotId)?"抽帧未见明确新问题，不是音画合格":"动作/连续性疑点，详见初审清单"),tailRisk:Number.isFinite(tail)&&tail<0.35};
});
const escape=s=>String(s||"").replaceAll("|","／").replaceAll("\n"," ");
const text=["# 风雨归人：43镜审核索引","","范围：当前选中候选；430帧抽查 + 本地 tiny ASR 筛查。无视频重抽/替换。", "语音识别含同音错字和繁简差异，匹配分数不可用作质量分数；不能确认声纹、口型、情绪或杂音。尾声时间也是ASR估计，不是实际截断结论。", "", "|镜号|画面初审|末句后余量估计|首秒脉冲候选|视频|", "|---|---|---|---|---|", ...rows.map(r=>`|${r.shotId}|${r.visualReview}|${r.estimatedTail}s${r.tailRisk?"，重点复听":""}|${r.onsetPulseCandidate?"有，可能是正常动作声":"未触发"}|[播放](<${r.videoPath.replaceAll("\\","/")}>)|`),"","## 逐镜原对白与识别结果",...rows.flatMap(r=>["",`### ${r.shotId}`,`原对白：${escape(r.expected)}`,"",`自动识别（未人工确认）：${escape(r.recognized)}`])].join("\n");
fs.writeFileSync(path.join(root,"43镜审核索引.md"),text,"utf8");
fs.writeFileSync(path.join(root,"combined-screening.json"),JSON.stringify({count:rows.length,confirmedVisualIssues:Object.keys(confirmed),visuallyNoNewIssue:[...visuallyClear],audioVerified:0,rows},null,2),"utf8");
console.log(JSON.stringify({count:rows.length,tailCandidates:rows.filter(r=>r.tailRisk).length,report:path.join(root,"43镜审核索引.md")}));
