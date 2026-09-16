"use strict";

// Controller tests use an in-memory DOM stub, not an OS/browser window.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app/renderer/post-production-panel.js"), "utf8");

function fixture(invoke = async () => ({ ok: true })) {
  const nodes = new Map();
  const intervals = new Set();
  const node = () => ({ value: "", dataset: {}, classList: { add() {} }, replaceChildren(...children) { this.children = children; }, focus() {}, select() {} });
  const host = { id: "test-post", dataset: {}, classList: { add() {} }, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, addEventListener(type, fn) { this[type] = fn; } };
  const context = { window: {}, document: { createElement: node }, navigator: { clipboard: { writeText: async () => {} } }, console, Date, setTimeout, clearTimeout, setInterval(callback) { const timer = { callback }; intervals.add(timer); return timer; }, clearInterval(timer) { intervals.delete(timer); } };
  vm.runInNewContext(source, context);
  let project = { id: "P1", shots: [{ id: "S01" }] };
  const calls = [], notices = [], refreshed = [];
  const panel = context.window.createPostProductionPanel({ host, getProject: () => project, invoke: async (...args) => { calls.push(args); return invoke(...args); }, refresh: async id => { refreshed.push(id); }, notify: (...args) => notices.push(args) });
  const button = action => host.querySelector(`[data-post-action="${action}"]`);
  const field = name => host.querySelector(`[data-post="${name}"]`);
  return { panel, host, calls, notices, refreshed, button, field, setProject(value) { project = value; panel.render(); }, tickPostPoll() { [...intervals].forEach(timer => timer.callback()); }, postPollCount() { return intervals.size; }, click(action) { const target = button(action); target.dataset.postAction = action; target.closest = () => target; return host.click({ target }); } };
}

test("local export guards duplicate click without locking another project", async () => {
  let resolve;
  const app = fixture(() => new Promise(done => { resolve = done; }));
  const running = app.panel.run("exportJianyingDraft");
  await app.panel.run("exportJianyingDraft");
  assert.equal(app.calls.length, 1);
  assert.equal(app.button("exportJianyingDraft").disabled, true);
  app.setProject({ id: "P2", shots: [{ id: "S02" }] });
  assert.equal(app.button("exportJianyingDraft").disabled, false);
  resolve({ ok: true });
  await running;
  assert.equal(app.refreshed[0], "P1");
  assert.equal(app.button("exportJianyingDraft").disabled, false);
});

test("a running local roughcut polls project truth and clears its poller when finished", async () => {
  let resolve;
  const app = fixture(() => new Promise(done => { resolve = done; }));
  const pending = app.panel.run("stitchProject");
  assert.equal(app.postPollCount(), 1);
  app.tickPostPoll();
  await Promise.resolve();
  assert.deepEqual(app.refreshed, ["P1"]);
  resolve({ ok: true });
  await pending;
  assert.equal(app.postPollCount(), 0);
});

test("failed API releases local controls and shows a useful retry error", async () => {
  let fail = true;
  const app = fixture(async () => fail ? { ok: false, message: "还缺 S01 的本地视频；请上传后重试。" } : { ok: true });
  await app.panel.run("exportJianyingDraft");
  assert.equal(app.button("exportJianyingDraft").disabled, false);
  assert.equal(app.field("error").hidden, false);
  assert.match(app.field("error").textContent, /S01/);
  fail = false;
  await app.panel.run("exportJianyingDraft");
  assert.equal(app.field("error").hidden, true);
  assert.equal(app.calls.length, 2);
});

test("raw exceptions do not leak through the error panel", async () => {
  const app = fixture(async () => { throw new TypeError("Cannot read properties of undefined"); });
  await app.panel.run("stitchProject");
  assert.doesNotMatch(app.field("error").textContent, /TypeError|undefined|Cannot/);
  assert.match(app.field("error").textContent, /检查素材/);
});

test("persistent progress is cancellable and does not require an active JS promise", async () => {
  const app = fixture(async () => ({ ok: true, result: { cancelled: false, message: "当前没有本地后期任务，可重新开始" } }));
  app.setProject({ id: "P1", shots: [{ id: "S01" }], postProductionTask: { status: "running", message: "正在复制" } });
  assert.equal(app.button("cancelPostProduction").disabled, false);
  await app.click("cancelPostProduction");
  assert.equal(app.calls[0][0], "cancelPostProduction");
  assert.match(app.notices.at(-1)[0], /可重新开始/);
  assert.equal(app.button("refresh").disabled, false);
});

test("saved draft truth distinguishes publication from verified native opening", () => {
  const app = fixture();
  app.setProject({ id: "P1", shots: [{ id: "S01" }], jianyingDraftExport: { draftPath: "D:\\project\\draft", installedDraftPath: "D:\\drafts\\draft", registered: true, subtitleTimingSource: "estimated-5.5cps", counts: { videos: 2, audioTracks: 3, sfxCues: 5, subtitles: 8 }, warnings: ["需预览校时"], stale: true } });
  assert.match(app.field("result-title").textContent, /重新导出最新/);
  assert.match(app.field("native-path").textContent, /已复制到剪映草稿目录/);
  assert.match(app.field("timing").textContent, /尚非成片语音实测/);
  assert.equal(app.field("path").value, "D:\\project\\draft");
  assert.equal(app.field("warning-list").children.length, 1);
});

test("confirmed backend interruption unlocks a stale frontend promise without unlocking another active task", async () => {
  let settle;
  const app = fixture(() => new Promise(resolve => { settle = resolve; }));
  const promise = app.panel.run("exportJianyingDraft");
  assert.equal(app.button("exportJianyingDraft").disabled, true);
  app.setProject({ id: "P1", shots: [{ id: "S01" }], postProductionTask: { status: "interrupted", updatedAt: new Date(Date.now() + 10).toISOString() } });
  assert.equal(app.button("exportJianyingDraft").disabled, false);
  assert.match(app.field("status").textContent, /已中断/);
  settle({ ok: false, message: "本地后期已取消" });
  await promise;
});

test("native destination edits survive switching projects", () => {
  const app = fixture();
  app.field("root").value = "D:\\剪映草稿";
  app.setProject({ id: "P2", shots: [{ id: "S02" }] });
  assert.equal(app.field("root").value, "");
  app.setProject({ id: "P1", shots: [{ id: "S01" }] });
  assert.equal(app.field("root").value, "D:\\剪映草稿");
});

test("both real HTML entry points load shared controller before their workspace", () => {
  for (const mode of ["workbench", "simple-mode"]) {
    const html = fs.readFileSync(path.join(__dirname, `../app/renderer/${mode}.html`), "utf8");
    assert.ok(html.indexOf('src="post-production-panel.js"') < html.indexOf(`src="${mode}.js"`));
    assert.match(html, mode === "workbench" ? /id="workbenchPostProduction"/ : /data-content="post"/);
  }
});

test("dialogue presentation supports structured legacy turns without changing source", () => {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const dialogue = [{ characterId: "C01", text: "我回来，是想把当年的误会说清楚。", startSeconds: 1, endSeconds: 5 }];
  const original = JSON.stringify(dialogue);
  const text = context.window.dramaDialogueText(dialogue, [{ id: "C01", name: "顾云舟" }]);
  assert.equal(text, "顾云舟：我回来，是想把当年的误会说清楚。");
  assert.equal(JSON.stringify(dialogue), original);
  assert.equal(context.window.dramaDialogueText("原样保存：旧式对白"), "原样保存：旧式对白");
  assert.equal(context.window.dramaDialogueText({ unrelated: true }), "");
});
