"use strict";
// T14: 净音粗剪、含音效预览与分轨导出（B08 + B20）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { matchStageSfx, sfxEvidenceKey } = require("../app/agent-stage-tasks");
const workflow = require("../app/workbench-workflow");
const { postAudioModeOf, mixFixedSfxIntoVideo } = workflow;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "t14-")); }

function catalog() {
  return [
    { id: "fx_door", name: "关门", tags: ["impact"], category: "emphasis", role: "accent", gainDb: -18, filePath: __filename },
    { id: "fx_step", name: "脚步", tags: ["footstep"], category: "foley", role: "bed", gainDb: -20, filePath: __filename }
  ];
}

function planWithShots(shotIds) {
  const shots = shotIds.map((id, index) => ({
    shotId: id,
    durationSeconds: 4,
    programmeOffsetSeconds: index * 4,
    cues: []
  }));
  return { shots, cueCount: 0, source: "script" };
}

function fakeGenerate(script) {
  let call = 0;
  return async (_provider, _messages, options = {}) => {
    const step = script[Math.min(call++, script.length - 1)];
    if (step.error) throw Object.assign(new Error(step.error), { code: "AGENT_SFX_INVALID" });
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { code: "ABORTED" });
    return { shots: step.shots };
  };
}

test("B20: 第二批失败时，第一批已验证的 cues 保留，仅失败批次进入待补", async () => {
  const project = { id: "p1", shots: ["s1", "s2", "s3", "s4", "s5", "s6"].map(id => ({ id, duration: 4 })) };
  // Batch1 = s1–s5 succeeds (only s1 gets a cue); batch2 = s6 fails.
  const generate = fakeGenerate([
    { shots: [
      { shotId: "s1", cues: [{ effectId: "fx_door", localTimeSeconds: 1.5, reason: "关门" }] },
      { shotId: "s2", cues: [] }, { shotId: "s3", cues: [] }, { shotId: "s4", cues: [] }, { shotId: "s5", cues: [] }
    ] },
    { error: "音效引用或时间无效" }
  ]);
  const result = await matchStageSfx(project, { textProvider: "x", localAgents: { stages: { postProduction: "api" } } }, catalog(), generate, {});
  assert.equal(result.status, "needs_attention");
  assert.equal(result.shots.find(s => s.shotId === "s1").cues.length, 1, "第一批已验证 cue 必须保留");
  assert.deepEqual(result.pendingShotIds, ["s6"], "只有失败与未发送的镜头待补");
  assert.equal(result.cueCount, 1);
});

test("B20: 带 previousPlan 重试只重新匹配待补镜头并复用已验证 cues", async () => {
  const project = { id: "p1", shots: ["s1", "s2", "s3", "s4", "s5", "s6"].map(id => ({ id, duration: 4 })) };
  const gen1 = fakeGenerate([
    { shots: [
      { shotId: "s1", cues: [{ effectId: "fx_door", localTimeSeconds: 1.5, reason: "关门" }] },
      { shotId: "s2", cues: [] }, { shotId: "s3", cues: [] }, { shotId: "s4", cues: [] }, { shotId: "s5", cues: [] }
    ] },
    { error: "x" }
  ]);
  const base = await matchStageSfx(project, { textProvider: "x", localAgents: { stages: { postProduction: "api" } } }, catalog(), gen1, {});
  const requested = [];
  const gen2 = async (_p, messages) => {
    const body = JSON.parse(messages[1].content);
    for (const shot of body.shots) requested.push(shot.shotId);
    return { shots: [{ shotId: "s6", cues: [{ effectId: "fx_step", localTimeSeconds: 2, reason: "脚步" }] }] };
  };
  const retried = await matchStageSfx(project, { textProvider: "x", localAgents: { stages: { postProduction: "api" } } }, catalog(), gen2, { previousPlan: base });
  assert.equal(retried.status, "completed");
  assert.deepEqual(requested, ["s6"], "重试必须只请求待补镜头");
  assert.equal(retried.shots.find(s => s.shotId === "s1").cues.length, 1, "复用 cue 不丢失");
  assert.equal(retried.shots.find(s => s.shotId === "s6").cues.length, 1);
  assert.equal(retried.cueCount, 2);
  assert.deepEqual(retried.pendingShotIds, []);
  assert.equal(retried.evidenceKey, sfxEvidenceKey(project), "evidenceKey 与输入一致，复用判定成立");
});

test("postAudioMode: 显式设置原样保留，缺省一律 preview_and_draft", () => {
  assert.equal(postAudioModeOf({ postAudioMode: "none" }), "none");
  assert.equal(postAudioModeOf({ postAudioMode: "draft_only" }), "draft_only");
  assert.equal(postAudioModeOf({ postAudioMode: "preview_and_draft" }), "preview_and_draft");
  assert.equal(postAudioModeOf({}), "preview_and_draft", "新项目默认可听到音效");
  assert.equal(postAudioModeOf({ postAudioMode: "garbage" }), "preview_and_draft");
});

test("mixFixedSfxIntoVideo 空计划不消费净音底片（B08 前提）", async () => {
  const dir = tmpDir();
  const base = path.join(dir, "clean.mp4");
  const out = path.join(dir, "sfx.mp4");
  fs.writeFileSync(base, "CLEAN");
  const result = await mixFixedSfxIntoVideo("ffmpeg-unused", base, out, { shots: [{ cues: [] }] }, catalog(), dir);
  assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(base, "utf8"), "CLEAN", "净音底片必须原样保留");
  assert.ok(!fs.existsSync(out), "无 cue 时不得产出预览文件");
});

test("stitch 工作流源码具备 preview/partial_audio/retry 三要素且合同通过", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "app", "workbench-workflow.js"), "utf8");
  assert.match(source, /roughcut-sfx-/, "必须输出独立含音效预览文件");
  assert.match(source, /partial_audio/, "必须记录 partial_audio 状态");
  assert.match(source, /async retrySfxPreview\(/, "必须有只补音效的重试入口");
  assert.match(source, /previousPlan:previousSfxPlan/, "重剪时必须复用已验证音效批次");
  const { auditPostProductionContract } = require("./post-production-build-contract");
  const read = file => fs.readFileSync(path.join(__dirname, "..", file));
  const result = auditPostProductionContract(read);
  assert.equal(result.ok, true);
});
