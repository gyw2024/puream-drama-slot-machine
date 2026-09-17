"use strict";
// T19: 应用级破坏性测试与长稿性能。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { FoundryRuntimeStore } = require("../app/foundry/runtime-store");
const { ProductionRepository } = require("../app/production-v2/repository");
const { AgentHub } = require("../app/local-agent-runtime");
const { buildProductionView, reduceEvents } = require("../app/production-v2/read-model");

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t19-"));
  const store = new FoundryRuntimeStore(dir);
  return { store, dir };
}

test("破坏性：事务中途崩溃必须整体回滚，不留半写状态", () => {
  const { store } = tempStore();
  // 事务内用底层 insert（appendProjectEvents 自带事务，不可嵌套）。
  const insert = store.db.prepare("INSERT INTO project_events (project_id,stream_seq,event_id,epoch,operation_id,type,stage,entity_ids_json,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  assert.throws(() => store.transaction(() => {
    insert.run("p1", 1, "e1", "e1", "", "operation.started", "", "[]", "{}", new Date().toISOString());
    throw new Error("simulated crash");
  }), /simulated crash/);
  assert.equal(store.projectEventCursor("p1").lastSeq, 0, "崩溃事务不得留下任何事件");
  // 崩溃后同一事务逻辑可以安全重放。
  const cursor = store.appendProjectEvents("p1", [{ eventId: "e1", type: "operation.started" }]);
  assert.equal(cursor.lastSeq, 1);
  store.close();
});

test("破坏性：租约持有人崩溃后，过期租约可被接管，旧租约提交被拒绝", () => {
  const { store } = tempStore();
  const repo = new ProductionRepository(store);
  const started = store.beginOperation({ projectId: "p1", kind: "video", targetId: "s1" });
  const claim = repo.claimOperation({ operationId: started.operationId, workerId: "w-crash", leaseTtlMs: 1000 });
  assert.equal(claim.leased, true, "首租必须成功");
  const firstEpoch = claim.leaseEpoch;
  // w-crash 崩溃，不再续租；TTL 过期后新 worker 接管。
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return sleep(1200).then(() => {
    const reclaim = repo.claimOperation({ operationId: started.operationId, workerId: "w2", leaseTtlMs: 60_000 });
    assert.equal(reclaim.leased, true, "过期租约必须可接管");
    assert.notEqual(reclaim.leaseEpoch, firstEpoch);
    // 旧持有者苏醒提交 → 必须 stale_attempt，不得污染数据。
    const stale = repo.commitOperation({ operationId: started.operationId, leaseEpoch: firstEpoch, result: { ok: true } });
    assert.equal(stale.status, "stale_attempt");
    const fresh = repo.commitOperation({ operationId: started.operationId, leaseEpoch: reclaim.leaseEpoch, result: { ok: true } });
    assert.equal(fresh.status, "committed");
    store.close();
  });
});

test("破坏性：Agent 进程死亡后重启，运行中任务标记 interrupted，迟到结果不复活", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t19-hub-"));
  const cryptoMod = crypto;
  {
    const hub = new AgentHub(root);
    hub.register({ agentId: "codex", workerId: "w1" });
    const id = "agent_" + cryptoMod.randomUUID();
    const job = { id, agentId: "codex", modality: "text", status: "running", workerId: "w1" };
    hub.jobs.set(id, job);
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "job.json"), JSON.stringify(job));
  }
  // 进程"崩溃"：全新 AgentHub 实例读取同一目录。
  const revived = new AgentHub(root);
  const job = [...revived.jobs.values()][0];
  assert.equal(job.status, "interrupted", "重启必须把运行中任务标记为 interrupted");
  const late = revived.archiveLateResult(job, { text: "迟到结果" });
  assert.ok(late, "迟到结果必须归档而非覆盖项目");
  assert.equal(job.status, "interrupted", "归档迟到结果不得改变终局状态");
});

test("破坏性：同一操作并发重复触发，只入队一次（无双倍计费）", () => {
  const { store } = tempStore();
  const input = { projectId: "p1", kind: "video", targetId: "s1", payload: { prompt: "same" } };
  const first = store.beginOperation(input);
  const second = store.beginOperation(input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, "重复触发必须折叠");
  assert.equal(second.attempts, 1, "折叠不得烧掉新的 attempt");
  store.close();
});

test("长稿性能：500 镜项目 read-model 与 5000 条事件流均在预算内", () => {
  const shots = Array.from({ length: 500 }, (_, i) => ({ id: `s${i + 1}`, number: i + 1, localVerified: i < 250, duration: 8 }));
  const project = { id: "big", input: { topic: "x" }, script: { raw: "长稿" }, shots, generation: { mode: "asset_direct" } };
  const t0 = process.hrtime.bigint();
  const view = buildProductionView(project, []);
  const viewMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(view.counts.shots, 500);
  assert.equal(view.counts.videosReady, 250);
  assert.ok(viewMs < 200, `read-model 500 镜耗时 ${viewMs.toFixed(1)}ms 超预算`);

  let state = { projectId: "big", lastSeq: 0, events: [] };
  const t1 = process.hrtime.bigint();
  for (let seq = 1; seq <= 5000; seq += 1) state = reduceEvents(state, { projectId: "big", seq, type: "operation.progress" });
  const feedMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(state.lastSeq, 5000);
  assert.ok(feedMs < 1500, `5000 事件流耗时 ${feedMs.toFixed(1)}ms 超预算`);
});
