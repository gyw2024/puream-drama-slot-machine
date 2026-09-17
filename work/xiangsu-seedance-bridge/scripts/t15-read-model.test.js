"use strict";
// T15: 统一 read-model 与项目事件游标。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { FoundryRuntimeStore } = require("../app/foundry/runtime-store");
const { nextAction, reduceEvents, buildProductionView } = require("../app/production-v2/read-model");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t15-"));
  const store = new FoundryRuntimeStore(dir);
  store.migrate();
  return { store, dir };
}

test("project_events：每个项目独立连续 streamSeq，互不干扰", () => {
  const { store } = tempStore();
  store.appendProjectEvents("p1", [{ eventId: "a1", type: "operation.started", payload: { operation: "x" } }, { eventId: "a2", type: "operation.completed" }]);
  store.appendProjectEvents("p2", [{ eventId: "b1", type: "operation.started" }]);
  store.appendProjectEvents("p1", [{ eventId: "a3", type: "operation.failed" }]);
  const p1 = store.listProjectEvents("p1");
  assert.deepEqual(p1.map(e => e.seq), [1, 2, 3], "p1 的流必须连续");
  assert.deepEqual(store.listProjectEvents("p2").map(e => e.seq), [1], "p2 独立从 1 开始");
  assert.equal(store.projectEventCursor("p1").lastSeq, 3);
  assert.equal(store.projectEventCursor("p2").lastSeq, 1);
  const after = store.listProjectEvents("p1", 2);
  assert.deepEqual(after.map(e => e.seq), [3], "afterSeq 游标只取增量");
});

test("project_events：重复 eventId 幂等拒绝，cursor 不回退", () => {
  const { store } = tempStore();
  store.appendProjectEvents("p1", [{ eventId: "dup", type: "operation.started" }]);
  assert.throws(() => store.appendProjectEvents("p1", [{ eventId: "dup", type: "operation.completed" }]));
  assert.equal(store.projectEventCursor("p1").lastSeq, 1);
});

test("reduceEvents：缺口触发 needsResync，旧事件与异项目事件忽略", () => {
  let state = { projectId: "p1", lastSeq: 0, events: [] };
  state = reduceEvents(state, { projectId: "p1", seq: 1 });
  state = reduceEvents(state, { projectId: "other", seq: 1 });
  assert.equal(state.lastSeq, 1, "异项目事件必须忽略");
  state = reduceEvents(state, { projectId: "p1", seq: 1 });
  assert.equal(state.lastSeq, 1, "旧事件必须忽略");
  state = reduceEvents(state, { projectId: "p1", seq: 3 });
  assert.equal(state.needsResync, true, "缺口必须触发重同步");
  state = reduceEvents(state, { projectId: "p1", seq: 2 });
  assert.equal(state.needsResync, false, "补上缺口后恢复连续");
});

test("buildProductionView：缺字段显示 unknown/not_ready，绝不回落成 completed", () => {
  const view = buildProductionView({}, []);
  assert.equal(view.counts.missingAssets, "unknown");
  assert.equal(view.counts.missingBoards, "unknown");
  assert.equal(view.stageSummary.videos, "not_ready");
  assert.equal(view.stageSummary.script, "unknown");
  assert.equal(view.artifacts.postAudioState, "not_ready");
  assert.equal(view.nextAction.id, "prepare_source", "空项目必须引导到文本准备");
});

test("buildProductionView：视频齐全必须满足本地验证（§9），远端 success 不算齐", () => {
  const project = {
    input: { topic: "x" }, script: { raw: "剧本" },
    shots: [{ id: "s1", localVerified: false }, { id: "s2", localVerified: true }],
    generation: { mode: "asset_direct" }
  };
  const view = buildProductionView(project, []);
  assert.equal(view.counts.videosReady, 1, "只有 localVerified 的镜头计入齐全");
  assert.notEqual(view.nextAction.id, "start_post", "未验证齐全不得进入后期");
  const full = buildProductionView({ ...project, shots: [{ id: "s1", localVerified: true }, { id: "s2", localVerified: true }], roughCutVideoPath: "p", finalVideoPath: "p", postAudioState: "preview_ready" }, []);
  assert.equal(full.nextAction.id, "preview_final", "齐全且成片当前时才引导预览");
});

test("buildProductionView：取消中 > 运行中 > 后期就绪 的优先级", () => {
  const base = { input: {}, script: { raw: "x" }, shots: [{ id: "s1", localVerified: true }], generation: { mode: "asset_direct" } };
  assert.equal(buildProductionView({ ...base, automation: { status: "cancelling" } }, []).nextAction.id, "wait_cancel");
  assert.equal(buildProductionView({ ...base, automation: { status: "running", stage: "videos" } }, []).nextAction.id, "view_progress");
  const finalReady = { ...base, finalVideoPath: "p" };
  assert.equal(buildProductionView({ ...finalReady, postAudioMode: "none" }).nextAction.title, "预览净音粗剪");
  assert.equal(buildProductionView(finalReady).nextAction.title, "预览含音效成片");
});

test("getProductionView：游标先于快照读取，握手不丢事件（§12.3）", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  const body = source.slice(source.indexOf("getProductionView(projectId"), source.indexOf("getProductionView(projectId") + 1400);
  const cursorAt = body.indexOf("projectEventCursor");
  const snapshotAt = body.indexOf("this.store.getProject(projectId)");
  assert.ok(cursorAt > -1 && snapshotAt > -1, "必须同时读取游标与快照");
  assert.ok(cursorAt < snapshotAt, "游标必须先于快照读取，避免快照与订阅之间丢事件");
  assert.match(source, /listProjectEvents\(projectId, afterSeq\)/, "必须按游标返回增量事件");
});
