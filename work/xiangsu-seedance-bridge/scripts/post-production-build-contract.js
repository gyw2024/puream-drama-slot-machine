"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const vm = require("node:vm");

const REQUIRED_POST_FILES = Object.freeze([
  "app/jianying-draft-export.js", "app/jianying-subtitles.js", "app/fixed-sfx-library.js", "app/local-media-context.js",
  "app/workbench-workflow.js", "app/workbench-store.js", "app/main.js", "app/preload.js",
  "app/mcp/app-controller.js", "app/mcp/control-client.js", "app/mcp/control-gateway.js", "app/mcp/stdio-server.js",
  "app/renderer/post-production-panel.js", "app/renderer/workbench.js", "app/renderer/workbench.html", "app/renderer/workbench.css",
  "app/renderer/simple-mode.js", "app/renderer/simple-mode.html", "app/renderer/simple-mode.css"
]);

function auditPostProductionContract(readFile) {
  const text = new Map(), files = [];
  for (const file of REQUIRED_POST_FILES) {
    const bytes = readFile(file);
    assert.ok(bytes.length > 20, `missing or empty post-production runtime file: ${file}`);
    const source = bytes.toString("utf8"); text.set(file, source);
    if (file.endsWith(".js")) new vm.Script(source, { filename: file });
    files.push({ file, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
  }
  const has = (file, pattern, label) => assert.match(text.get(file), pattern, `${file}: ${label}`);
  const writer = "app/jianying-draft-export.js", subtitles = "app/jianying-subtitles.js", workflow = "app/workbench-workflow.js";
  has(writer, /exportJianyingDraft/, "native writer export is missing");
  for (const token of ["audio_fades", "fade_in_duration", "fade_out_duration", "subtitleTimingSource", "subtitleWarnings", "subtitles.srt", "LOCAL_MEDIA_CANCELLED", "sha256", "puream_source.json", "draft_content.json", "draft_meta_info.json", "source_timerange", "target_timerange"]) assert.ok(text.get(writer).includes(token), `${writer}: missing ${token}`);
  has(subtitles, /module\.exports\s*=\s*\{[^}]*buildSubtitles[^}]*toSrt/s, "subtitle/SRT public functions are missing");
  for (const method of ["exportJianyingDraft", "cancelPostProduction", "stitchProjectLocal"]) assert.ok(text.get(workflow).includes(`${method}(`), `workflow method ${method} is missing`);
  has(workflow, /separate-draft-tracks/, "rough-cut must retain separate track mode");
  // T14 / §10: the CLEAN roughcut still never burns SFX in — but the workflow
  // must produce a separate audible roughcut-sfx preview with an explicit
  // partial_audio fallback and a retry that never re-cuts videos.
  has(workflow, /await\s+mixFixedSfxIntoVideo\s*\(/, "audible sfx preview is not produced in the rough-cut workflow");
  has(workflow, /roughcut-sfx-/, "missing separate roughcut-sfx- preview output; sfx must not overwrite the clean roughcut");
  has(workflow, /partial_audio/, "partial_audio outcome state is missing");
  has(workflow, /postAudioMode/, "postAudioMode setting is missing");
  has(workflow, /retrySfxPreview\(/, "sfx-only retry entry is missing");
  assert.match(readFile("app/agent-stage-tasks.js").toString(), /pendingShotIds/, "agent-stage-tasks must track pending sfx shots instead of discarding validated batches");
  assert.ok(text.get("app/mcp/stdio-server.js").includes('registerAppTool(server, "retry_sfx_preview"'), "missing unbilled sfx retry MCP tool");

  // Execute only the preload adapter in a JS VM with mocked Electron imports.
  // No Electron process, browser, window, IPC server or real user data is used.
  let exposed = null;
  const calls = [];
  new vm.Script(text.get("app/preload.js")).runInNewContext({ require(name) {
    assert.equal(name, "electron", "unexpected preload dependency");
    return { contextBridge: { exposeInMainWorld(name, bridge) { assert.equal(name, "dramaSlot"); exposed = bridge; } }, ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ ok: true }); }, on() {}, removeListener() {} } };
  } }, { timeout: 1000 });
  assert.ok(exposed?.workbench && exposed?.simple, "both UI adapters must be exposed");
  exposed.workbench.stitch("test-project");
  exposed.workbench.exportJianyingDraft("test-project", { draftRoot: "test-root" });
  exposed.workbench.cancelPostProduction("test-project");
  for (const method of ["stitchProject", "exportJianyingDraft", "cancelPostProduction"]) exposed.simple.call(method, "test-project");
  assert.deepEqual(calls.map(row => row[0]), ["workbench:stitch", "workbench:export-jianying", "workbench:cancel-post-production", "simple:call", "simple:call", "simple:call"]);
  for (const channel of calls.slice(0, 3).map(row => row[0])) assert.ok(text.get("app/main.js").includes(`ipcMain.handle("${channel}"`), `missing IPC handler ${channel}`);
  for (const method of ["stitchProject", "exportJianyingDraft", "cancelPostProduction"]) assert.ok(text.get("app/main.js").includes(`case "${method}"`), `missing simple adapter ${method}`);
  for (const method of ["stitch_final_video", "export_jianying_draft", "cancel_post_production"]) {
    assert.ok(text.get("app/mcp/stdio-server.js").includes(`registerAppTool(server, "${method}"`), `missing unbilled local MCP tool ${method}`);
    assert.ok(text.get("app/mcp/app-controller.js").includes(method), `missing MCP controller ${method}`);
    assert.ok(!text.get("app/mcp/stdio-server.js").includes(`billable("${method}"`), `local export unexpectedly declared billable: ${method}`);
  }
  for (const mode of ["workbench", "simple-mode"]) {
    const html = text.get(`app/renderer/${mode}.html`);
    const sharedAt = html.indexOf('<script src="post-production-panel.js"');
    const entryAt = html.indexOf(`<script src="${mode}.js"`);
    assert.ok(sharedAt >= 0 && entryAt > sharedAt, `${mode}: shared post-production controller must load before entry script`);
    assert.ok(html.includes(mode === "workbench" ? 'id="workbenchPostProduction"' : 'id="simplePostProduction"'), `${mode}: post-production panel host missing`);
    has(`app/renderer/${mode}.js`, /window\.createPostProductionPanel\(/, "shared panel controller not wired");
    has(`app/renderer/${mode}.css`, /\.post-production-panel/, "shared panel styling not packaged");
  }
  for (const method of ["stitchProject", "exportJianyingDraft", "cancelPostProduction", "refresh", "retrySfxPreview"]) assert.ok(text.get("app/renderer/post-production-panel.js").includes(`data-post-action="${method}"`), `missing recoverable UI action ${method}`);
  return { ok: true, mode: "static-source-and-mocked-preload-only", files, nativeWindowLaunched: false, paidRequests: 0, preloadChannels: calls.map(row => row[0]), mcpTools: ["stitch_final_video", "export_jianying_draft", "cancel_post_production"] };
}

module.exports = { REQUIRED_POST_FILES, auditPostProductionContract };
