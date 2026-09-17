'use strict';
// Locks the delivery payload size contract.
//
// The same output schema used to reach the Agent four times over: indented in
// instructions.json, indented again in schema.json, and inlined in full in both
// MCP tool advertisements — permanently, on every turn. Every copy was the same
// schema, so the fix keeps exactly one complete copy (instructions.json) and
// reduces the rest to a top-level skeleton. These tests fail if any copy grows
// back. They assert structure, not byte counts, so an unrelated schema edit does
// not make them brittle.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const parts = require('../app/mcp/stage-parts');
const files = require('../app/mcp/stage-files');
const server = require('../app/mcp/stage-delivery-server');
const delivery = require('../app/mcp/stage-delivery');

// Padding that stands in for the real per-shot field bodies (a single
// objectStates definition runs to ~8k characters in production). Everything
// below the first two levels is repeated once per shot, so it is exactly the
// part that must not be copied into the tool advertisements.
const PADDING = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`detailField_${i}`, { type: 'string', description: `per-shot detail ${i}` }]));
const SHOT_FIELDS = {
  objectStates: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { objectId: { type: 'string' }, stateEn: { type: 'string' }, stateZh: { type: 'string' }, ...PADDING }, required: ['objectId', 'stateEn', 'stateZh'] } },
  events: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, detail: { type: 'string' }, ...PADDING } } },
  dialogue: { type: 'array', items: { type: 'object', properties: { speakerId: { type: 'string' }, text: { type: 'string' }, emotion: { type: 'string' } } } }
};
function shotBranch(id) {
  const properties = { shotId: { const: id }, duration: { type: 'integer' } };
  for (const [key, value] of Object.entries(SHOT_FIELDS)) properties[key] = value;
  return { type: 'object', additionalProperties: false, properties, required: ['shotId', 'duration', ...Object.keys(SHOT_FIELDS)] };
}
const SCHEMA = { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { anyOf: ['shot-01', 'shot-02', 'shot-03', 'shot-04', 'shot-05'].map(shotBranch) } } } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-payload-')), dir = path.join(root, 'agent_payload');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ jobId: 'agent_payload', json: true, responseSchema: SCHEMA, requiredKeys: ['items'], messages: [{ role: 'user', content: '这一批 5 个镜头。' }] }));
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ status: 'running' }));
  return dir;
}
const advertise = value => JSON.stringify(value['~standard'].jsonSchema.input());
const advertisedData = value => value['~standard'].jsonSchema.input().properties.data;

test('instructions.json and schema.json reach the Agent as compact JSON', t => {
  const dir = fixture(t);
  const page = files.read(dir, { name: 'instructions.json', length: 24000 });
  const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  const expected = JSON.stringify(delivery.modelView(request));
  assert.equal(page.totalCharacters, expected.length, '夹具必须放进一页，断言才针对完整内容');
  assert.equal(page.text, expected, '模型读到的是紧凑 JSON');
  assert.equal(files.read(dir, { name: 'schema.json', length: 24000 }).text, JSON.stringify(request.responseSchema));
  assert.ok(!page.text.includes('\n'), '缩进空白不再进入分页读取的内容');
  assert.ok(page.text.length < JSON.stringify(delivery.modelView(request), null, 2).length / 1.4, '紧凑化必须真的省下可观字符');
});

test('tool advertisements carry the top-level shape instead of a second full schema', () => {
  const request = { jobId: 'agent_payload', json: true, responseSchema: SCHEMA };
  const submit = advertise(server.deliveryInputSchema(request)), part = advertise(server.partInputSchema(request));
  const full = JSON.stringify(SCHEMA);
  assert.ok(submit.length + part.length < full.length, '工具定义不得再内联完整 schema');
  // 提交方仍要能知道该交什么：顶层 required、字段名、列表项 required、逐镜 const 都保留
  const data = advertisedData(server.deliveryInputSchema(request));
  assert.deepEqual(data.required, ['items']);
  assert.equal(data.properties.items.items.anyOf.length, 5);
  assert.deepEqual(data.properties.items.items.anyOf[0].required, ['shotId', 'duration', 'objectStates', 'events', 'dialogue']);
  assert.equal(data.properties.items.items.anyOf[0].properties.shotId.const, 'shot-01');
  assert.equal(data.properties.items.items.anyOf[4].properties.shotId.const, 'shot-05');
  assert.ok(submit.includes('shot-01') && part.includes('shot-01'), '逐镜身份约束仍可见，避免串镜');
});

test('per-shot field bodies live only in instructions.json, never in a tool advertisement', () => {
  const request = { jobId: 'agent_payload', json: true, responseSchema: SCHEMA };
  const submit = advertise(server.deliveryInputSchema(request)), part = advertise(server.partInputSchema(request));
  const skeleton = JSON.stringify(parts.interfaceSkeleton(SCHEMA));
  const full = JSON.stringify(SCHEMA);
  // 内层字段名是每镜重复最多次的内容；骨架与工具定义都不该再带上它
  for (const marker of ['detailField_0', 'detailField_19', 'stateZh', 'speakerId']) {
    assert.ok(full.includes(marker), `${marker} 必须真的在原始 schema 里`);
    assert.ok(!skeleton.includes(marker), `骨架不得复制 ${marker}`);
    assert.ok(!submit.includes(marker), `submit 工具定义不得复制 ${marker}`);
    assert.ok(!part.includes(marker), `part 工具定义不得复制 ${marker}`);
  }
  // 字段名本身是接口形状，必须保留，模型才知道 item 有哪些字段
  const branch = parts.interfaceSkeleton(SCHEMA).properties.items.items.anyOf[0];
  assert.deepEqual(branch.properties.objectStates, { type: 'array' });
  assert.deepEqual(branch.properties.dialogue, { type: 'array' });
  assert.ok(skeleton.length < full.length, '骨架必须小于它概括的完整 schema');
});

test('stage_result_part still advertises the declared field names and kinds', () => {
  const request = { jobId: 'agent_payload', json: true, responseSchema: SCHEMA, progressiveDelivery: true };
  const data = advertisedData(server.partInputSchema(request));
  assert.ok(data.anyOf.some(s => s.type === 'array' && s.items), '被 stage 的数组字段仍广告为数组');
  assert.equal(JSON.stringify(data).includes('stateZh'), false, '片段广告也不再重复内层定义');
});

test('the skeleton builder is total: odd or missing schemas never throw', () => {
  for (const value of [undefined, null, {}, [], { type: 'object' }, { anyOf: [{ type: 'string' }] }, { items: { type: 'array' } }, { type: 'object', properties: {} }, { type: 'array', items: [] }]) {
    const skeleton = parts.interfaceSkeleton(value);
    assert.equal(typeof skeleton, 'object');
    assert.ok(!Array.isArray(skeleton));
    JSON.stringify(skeleton);
  }
});

test('submissions are still checked against the full schema, not the skeleton', t => {
  const dir = fixture(t);
  const incomplete = delivery.submit(dir, { data: { items: [{ shotId: 'shot-01' }] } });
  assert.equal(incomplete.status, 'needs_revision');
  assert.ok(incomplete.findings.length, '骨架不参与校验，缺失字段仍被逐项指出');
  assert.equal(delivery.read(dir), null);
});
