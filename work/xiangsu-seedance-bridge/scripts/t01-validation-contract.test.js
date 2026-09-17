'use strict';
// T01 权威校验与完整结果保存止漏 —— 合同测试。
// 运行: node --test scripts/t01-validation-contract.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { conforms, stableStringify, validateSchemaSupported, validateSubmittedValue } = require('../app/typed-output-receipt');
const { safeResult } = require('../app/mcp/app-controller');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t01-'));
}

// ---------- conforms 规范化比较 ----------
test('conforms: enum 对象比较不受 key 顺序影响', () => {
  const schema = { enum: [{ b: 2, a: 1 }] };
  assert.equal(conforms({ a: 1, b: 2 }, schema), true, 'key 顺序不同但语义相同，必须通过');
  assert.equal(conforms({ a: 1, b: 3 }, schema), false);
});

test('conforms: const 对象比较不受 key 顺序影响', () => {
  const schema = { const: { x: [1, { z: 1, y: 2 }] } };
  assert.equal(conforms({ x: [1, { y: 2, z: 1 }] }, schema), true);
  assert.equal(conforms({ x: [1, { y: 2, z: 2 }] }, schema), false);
});

test('conforms: uniqueItems 用规范化比较识别 key 顺序不同的重复对象', () => {
  const schema = { type: 'array', uniqueItems: true };
  assert.equal(conforms([{ a: 1, b: 2 }, { b: 2, a: 1 }], schema), false, '语义重复必须判 false');
  assert.equal(conforms([{ a: 1, b: 2 }, { a: 1, b: 3 }], schema), true);
});

test('stableStringify: 嵌套结构与数组顺序保持', () => {
  assert.equal(stableStringify({ b: [1, { c: 2, a: 3 }], a: 'x' }), '{"a":"x","b":[1,{"a":3,"c":2}]}');
});

// ---------- validateSchemaSupported ----------
test('validateSchemaSupported: 支持的 schema 返回 ok', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object', additionalProperties: false,
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } }
  };
  assert.deepEqual(validateSchemaSupported(schema), { ok: true, unsupported: [] });
});

test('validateSchemaSupported: format 作为注解被接受', () => {
  assert.equal(validateSchemaSupported({ type: 'string', format: 'date-time' }).ok, true);
});

test('validateSchemaSupported: 不支持关键字报出路径', () => {
  const r = validateSchemaSupported({ type: 'object', properties: { a: { oneOf: [{ type: 'string' }] } } });
  assert.equal(r.ok, false);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].keyword, 'oneOf');
  assert.match(r.unsupported[0].path, /properties\.a/);
});

// ---------- validateSubmittedValue ----------
test('validateSubmittedValue: 合法值 valid 且无 findings', () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  assert.deepEqual(validateSubmittedValue({ id: 'shot_1' }, schema), { valid: true, findings: [] });
});

test('validateSubmittedValue: 非法值 valid=false 且给出来自 inspect 的 findings', () => {
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const v = validateSubmittedValue({ id: 42 }, schema);
  assert.equal(v.valid, false);
  assert.ok(Array.isArray(v.findings) && v.findings.length > 0, '必须给出 findings');
});

test('validateSubmittedValue: 校验器不认识的 schema 关键字也判 invalid（inspect 漏报时给默认 finding）', () => {
  // oneOf 不被 conforms 支持 → 恒 false；inspect 同样不认识时可能返回空，
  // 此时 validateSubmittedValue 必须兜底一条默认 finding，不允许放行。
  const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  const v = validateSubmittedValue('anything', schema);
  assert.equal(v.valid, false);
  assert.ok(v.findings.length >= 1);
  assert.equal(v.findings[0].path, '$');
});

// ---------- stage-delivery submit：非法 schema 不能 saved ----------
test('stage-delivery.submit: schema 非法的提交返回 needs_revision 且不写 mcp-result.json', () => {
  const dir = tmpDir();
  const request = {
    version: 1, jobId: 'job_t01_a', json: true,
    responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }
  };
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request), 'utf8');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ status: 'running' }), 'utf8');
  const { submit } = require('../app/mcp/stage-delivery');
  const result = submit(dir, { data: { ok: '不是布尔' } });
  assert.equal(result.status, 'needs_revision');
  assert.ok(fs.existsSync(path.join(dir, 'mcp-submissions.jsonl')), '提交流水应记录');
  assert.equal(fs.existsSync(path.join(dir, 'mcp-result.json')), false, '非法结果绝不能 saved');
});

test('stage-delivery.submit: 合法提交写 mcp-result.json 且 sha256 一致', () => {
  const dir = tmpDir();
  const request = {
    version: 1, jobId: 'job_t01_b', json: true,
    responseSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false }
  };
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request), 'utf8');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ status: 'running' }), 'utf8');
  const { submit, read } = require('../app/mcp/stage-delivery');
  const result = submit(dir, { data: { ok: true } });
  assert.equal(result.status, 'saved');
  const saved = read(dir);
  assert.ok(saved, 'read 必须能读回结果');
  const hash = crypto.createHash('sha256').update(JSON.stringify(saved.value)).digest('hex');
  assert.equal(hash, saved.receipt.sha256);
});

// ---------- safeResult：大结果完整持久化 ----------
test('safeResult: 小结果保持内联', () => {
  const value = { hello: 'world' };
  assert.deepEqual(safeResult(value), { hello: 'world' });
});

test('safeResult: 有 artifactStore 时大结果完整落盘并返回引用与哈希', () => {
  const dir = tmpDir();
  const big = { payload: 'x'.repeat(200_000) };
  const out = safeResult(big, { dir, id: 'mcpop_test_artifact' });
  assert.equal(out.resultComplete, true);
  assert.equal(out.previewTruncated, true);
  assert.match(out.artifactRef, /^operation-result:mcpop_test_artifact$/);
  const file = path.join(dir, 'artifacts', 'mcpop_test_artifact.json');
  assert.ok(fs.existsSync(file), 'artifact 文件必须存在');
  const text = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(hash, out.sha256, '返回的 sha256 必须等于落盘内容哈希');
  assert.equal(JSON.parse(text).payload.length, 200_000, '完整正文不能丢');
});

test('safeResult: 无 artifactStore 时大结果明确标记 resultComplete=false', () => {
  const out = safeResult({ payload: 'y'.repeat(200_000) }, null);
  assert.equal(out.resultComplete, false);
  assert.equal(out.previewTruncated, true);
});

test('safeResult: artifact 目录不可写时 resultComplete=false 且带错误码', () => {
  const dir = tmpDir();
  // 把 artifacts 建成文件，使 mkdirSync 失败
  fs.writeFileSync(path.join(dir, 'artifacts'), 'not a dir', 'utf8');
  const out = safeResult({ payload: 'z'.repeat(200_000) }, { dir, id: 'mcpop_test_fail' });
  assert.equal(out.resultComplete, false);
  assert.ok(out.artifactError, '必须带错误码');
});

// ---------- read_operation_result：分页读取 ----------
test('McpAppController.readOperationResult: 分页、哈希校验与引用绑定', () => {
  const { McpAppController } = require('../app/mcp/app-controller');
  const dir = tmpDir();
  const fakeStore = { rootDir: dir, getSettings: () => ({}), listProjects: () => [], listDeletedProjects: () => [], listReusableAssets: () => [], listActiveVideoJobs: () => [] };
  const controller = new McpAppController({ store: fakeStore, workflow: { hasActiveOperation: () => false } });
  const big = { payload: '一二三四五'.repeat(30_000) }; // 150,012 字符 > 120KB，中文多字节
  const record = { operationId: 'mcpop_read_test', status: 'completed', result: null };
  controller.operations.set(record.operationId, record);
  record.result = controller.safeOperationResult(record, big);
  assert.equal(record.result.resultComplete, true);

  const first = controller.readOperationResult({ operation_id: 'mcpop_read_test', artifact_ref: record.result.artifactRef, offset: 0, length: 1000 });
  assert.equal(first.ok, true);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 1000);
  assert.ok(first.totalCharacters > 120_000);
  assert.ok(Buffer.byteLength(first.chunk, 'utf8') <= 3000, '中文分页按字符切，字节接近上限');

  // 翻到末页 nextOffset=null
  const last = controller.readOperationResult({ operation_id: 'mcpop_read_test', artifact_ref: record.result.artifactRef, offset: first.totalCharacters - 5, length: 1000 });
  assert.equal(last.nextOffset, null);

  // 错误引用拒绝
  assert.throws(() => controller.readOperationResult({ operation_id: 'mcpop_read_test', artifact_ref: 'operation-result:other' }), /MCP_OPERATION_ARTIFACT_NOT_FOUND|结果引用/);
  // 任意 filePath 永远打不开
  assert.throws(() => controller.readOperationResult({ operation_id: 'mcpop_read_test', artifact_ref: 'C:/Windows/win.ini' }), /结果引用|ARTIFACT/);
  // 哈希篡改检测
  const file = path.join(dir, 'mcp-operations', 'artifacts', 'mcpop_read_test.json');
  fs.writeFileSync(file, '{"tampered":true}', 'utf8');
  assert.throws(() => controller.readOperationResult({ operation_id: 'mcpop_read_test', artifact_ref: record.result.artifactRef }), /MCP_ARTIFACT_HASH_MISMATCH|校验/);
});

// ---------- local-agent-runtime 前置校验（静态接线检查） ----------
test('local-agent-runtime: responseSchema 前置校验已接入 request.json 写入前', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'local-agent-runtime.js'), 'utf8');
  const at = src.indexOf('atomicJson(path.join(dir,"request.json"),completeRequest)');
  const preflight = src.indexOf('validateSchemaSupported');
  assert.ok(at > 0 && preflight > 0 && preflight < at, '前置校验必须在写 request.json 之前执行');
});
