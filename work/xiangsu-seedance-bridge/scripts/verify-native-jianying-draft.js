"use strict";
// Explicit one-off acceptance fixture. Creates only a new named draft; reads
// native indexes without modifying them, and never starts or controls Jianying.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { exportJianyingDraft, detectJianyingDraftRoot, validateJianyingDraft } = require("../app/jianying-draft-export");
const root = path.resolve(__dirname, "..");
const evidence = path.join(root, ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "native-acceptance");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function optionalHash(file) { return fsp.readFile(file).then(hash).catch(() => null); }

async function main() {
  const draftRoot = await detectJianyingDraftRoot();
  assert.ok(draftRoot && (await fsp.stat(draftRoot)).isDirectory(), "A real native Jianying draft root must exist");
  const testRoot = path.join(root, ".codex_tests", "TASK-20260905-DRAMA-JIANYING-DRAFT-001", "native-writer");
  const cases = await fsp.readdir(testRoot);
  const available = (await Promise.all(cases.map(async name => {
    const file = path.join(testRoot, name, "real.mp4"); const stat = await fsp.stat(file).catch(() => null); return stat?.isFile() ? { file, modified: stat.mtimeMs } : null;
  }))).filter(Boolean).sort((a, b) => b.modified - a.modified);
  assert.ok(available.length, "Run jianying-draft-export.test.js to create a real local media fixture first");
  const video = available[0].file;
  const audio = path.join(root, "app", "assets", "builtin-sfx", "audio", "SFX-001.ogg");
  const ownedFiles = [path.join(draftRoot, "root_meta_info.json"), path.join(process.env.LOCALAPPDATA, "JianyingPro", "User Data", "Projects", "com.lveditor.draft", "root_meta_info.json"), path.join(process.env.LOCALAPPDATA, "JianyingPro", "User Data", "Config", "Modules", "draft_tracking.ini")];
  const before = await Promise.all(ownedFiles.map(async file => ({ file, sha256: await optionalHash(file) })));
  const result = await exportJianyingDraft({
    project: { id: `native-acceptance-${crypto.randomUUID()}`, title: "纯梦剪映导出验收-0.16.168" },
    videoClips: [{ shotId: "TEST-S01", filePath: video, startSeconds: 0, durationSeconds: 0.4, sourceStartSeconds: 0.1, sourceDurationSeconds: 0.5, width: 64, height: 96 }],
    subtitles: [{ text: "独立字幕验收", startUs: 0, durationUs: 350000, speaker: "测试" }],
    subtitleTimingSource: "synthetic-fixture-known-timeline", subtitleWarnings: ["这是0.4秒彩色测试画面和合成音的草稿导出验收，不是真实短剧或ASR口型验收。"],
    sfxPlan: { cues: [{ effectId: "SFX-001", role: "accent", programmeTimeSeconds: 0.1, durationSeconds: 0.2, gainDb: -20, fadeInSeconds: 0.01, fadeOutSeconds: 0.03 }] },
    catalog: [{ id: "SFX-001", filePath: audio, displayName: "咚咚强调验收" }],
    outputRoot: path.join(evidence, "project", "exports", "jianying"), draftRoot
  });
  assert.equal(result.registered, true);
  const checked = await validateJianyingDraft(result.installedDraftPath, result.fingerprint);
  assert.equal(checked.content.name, "纯梦剪映导出验收-0.16.168");
  assert.deepEqual(checked.content.tracks.map(track => track.type), ["video", "audio", "text"]);
  assert.equal(checked.content.id, checked.meta.draft_id);
  const media = [];
  for (const resource of checked.manifest.resources) {
    const target = path.join(result.installedDraftPath, "resources", resource.name);
    assert.equal(await optionalHash(target), await optionalHash(resource.source));
    execFileSync(path.join(root, "media-tools", "ffmpeg.exe"), ["-hide_banner", "-v", "error", "-i", target, "-f", "null", "-"], { windowsHide: true, timeout: 15000, stdio: "pipe" });
    media.push({ path: target, source: resource.source, sha256: resource.sha256, decoded: true });
  }
  const after = await Promise.all(ownedFiles.map(async file => ({ file, sha256: await optionalHash(file) })));
  const nativeIndexObservations = [];
  for (const file of ownedFiles.filter(file => file.endsWith("root_meta_info.json"))) {
    const index = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => ({}));
    const matches = (index.all_draft_store || []).filter(draft => draft.draft_id === result.draftId || String(draft.draft_fold_path || "").replace(/\\/g, "/").toLowerCase() === result.installedDraftPath.replace(/\\/g, "/").toLowerCase());
    nativeIndexObservations.push({ path: file, matchingDrafts: matches.map(item => ({ draft_id: item.draft_id, draft_name: item.draft_name, draft_fold_path: item.draft_fold_path })) });
  }
  const report = { ok: true, evidenceType: "native-directory-file-hash-media-decode-only", nativeAppStarted: false, nativeCanvasOpened: false, nativeOwnedFilesChangedDuringObservation: before.filter((item,i) => item.sha256 !== after[i].sha256).map(item => item.file), indexMutationByThisScript: false, before, after, nativeIndexObservations, result, counts: checked.manifest.counts, media };
  await fsp.mkdir(evidence, { recursive: true });
  const file = path.join(evidence, `acceptance-${Date.now()}.json`);
  await fsp.writeFile(file, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, draftPath: result.draftPath, installedDraftPath: result.installedDraftPath, draftId: result.draftId, counts: report.counts, sourceAndCopyHashesMatch: true, decodedMediaCount: media.length, nativeIndexMatchCount: nativeIndexObservations.reduce((count,row) => count+row.matchingDrafts.length,0), nativeCanvasOpened: false, report: file },null,2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
