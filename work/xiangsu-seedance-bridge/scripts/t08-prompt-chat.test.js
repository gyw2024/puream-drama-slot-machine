'use strict';
// T08 合同测试：单条聊天后端与专用 Schema（§6）。
// 运行: node --test scripts/t08-prompt-chat.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FoundryRuntimeStore } = require('../app/foundry/runtime-store');
const { PromptChatService, REPLY_SCHEMA } = require('../app/production-v2/prompt-chat');
const { textHash } = require('../app/production-v2/contracts');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puream-t08-'));
  const store = new FoundryRuntimeStore(dir);
  const items = new Map([
    ['item_1', { itemId: 'item_1', itemRevision: 3, displayText: '0123456789这段动作要更克制。abcdefgh', executionPrompt: 'EXEC v3', meta: { relatedFacts: { char: 'char_a' } } }]
  ]);
  const service = new PromptChatService({
    db: store.db,
    loadItem: (projectId, itemId) => items.get(itemId) || null,
    saveItem: (projectId, itemId, { displayText, executionPrompt, expectedItemRevision }) => {
      const item = items.get(itemId);
      if (Number(expectedItemRevision) !== Number(item.itemRevision)) throw Object.assign(new Error('conflict'), { code: 'EDIT_CONFLICT' });
      item.displayText = displayText; item.executionPrompt = executionPrompt; item.itemRevision += 1;
      return { itemRevision: item.itemRevision };
    },
    model: async ({ messages }) => ({
      verdict: 'proposal',
      assistantMessage: '已把这一段的动作改得更克制，人物和对白保持不变。',
      replacementDisplay: '这段动作更克制了',
      proposedExecutionPrompt: 'EXEC v4',
      changeReasons: ['应用户本轮要求'],
      dependencyFindings: []
    })
  });
  return { store, service, items };
}

const REPLY = {
  verdict: 'proposal', assistantMessage: 'ok',
  replacementDisplay: '新文字', proposedExecutionPrompt: 'EXEC NEW',
  changeReasons: [], dependencyFindings: []
};

test('专用 schema: verdict 只允许 proposal/needs_decision', () => {
  assert.deepEqual(REPLY_SCHEMA.properties.verdict.enum, ['proposal', 'needs_decision']);
  const { validateSubmittedValue } = require('../app/typed-output-receipt');
  assert.equal(validateSubmittedValue(REPLY, REPLY_SCHEMA).valid, true);
  assert.equal(validateSubmittedValue({ ...REPLY, verdict: 'approved' }, REPLY_SCHEMA).valid, false);
});

test('createThread: 建线程并校验 itemRevision', () => {
  const { service } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1', expectedItemRevision: 3 });
  assert.ok(t.threadId.startsWith('thread_'));
  assert.throws(() => service.createThread({ projectId: 'p1', itemId: 'item_1', expectedItemRevision: 2 }), e => e.code === 'REVISION_CONFLICT');
});

test('sendTurn: 选区双校验（哈希+选中文本），回复按专用 schema 验证', async () => {
  const { service } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1' });
  const bad = { type: 'selection', startUtf16: 10, endUtf16: 18, selectedText: '不是原文', baseTextHash: textHash('0123456789这段动作要更克制。abcdefgh') };
  await assert.rejects(() => service.sendTurn({ projectId: 'p1', threadId: t.threadId, clientTurnId: 't1', scope: bad, instruction: '改克制' }), e => e.code === 'SELECTION_MISMATCH');
  const good = { type: 'selection', startUtf16: 10, endUtf16: 18, selectedText: "这段动作要更克制", baseTextHash: textHash('0123456789这段动作要更克制。abcdefgh') };
  const turn = await service.sendTurn({ projectId: 'p1', threadId: t.threadId, clientTurnId: 't1', scope: good, instruction: '改克制' });
  assert.equal(turn.reply.verdict, 'proposal');
  // 幂等：同 clientTurnId 重放
  const replay = await service.sendTurn({ projectId: 'p1', threadId: t.threadId, clientTurnId: 't1', scope: good, instruction: '改克制' });
  assert.equal(replay.replayed, true);
});

test('sendTurn: needs_decision 不得暗含可应用补丁；proposal 执行稿不得为空', async () => {
  const { service } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1' });
  service.model = async () => ({ ...REPLY, verdict: 'needs_decision', replacementDisplay: '偷偷带补丁', proposedExecutionPrompt: 'X' });
  await assert.rejects(() => service.sendTurn({ projectId: 'p1', threadId: t.threadId, instruction: 'x' }), e => e.code === 'CHAT_REPLY_CONTRADICTORY');
  service.model = async () => ({ ...REPLY, proposedExecutionPrompt: '  ' });
  await assert.rejects(() => service.sendTurn({ projectId: 'p1', threadId: t.threadId, instruction: 'x' }), e => e.code === 'CHAT_REPLY_EMPTY_EXECUTION');
});

test('applyProposal: 选区只替换选区、itemRevision+1、无关进度不冲突', async () => {
  const { service, items } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1' });
  const good = { type: 'selection', startUtf16: 10, endUtf16: 18, selectedText: "这段动作要更克制", baseTextHash: textHash('0123456789这段动作要更克制。abcdefgh') };
  const turn = await service.sendTurn({ projectId: 'p1', threadId: t.threadId, clientTurnId: 't2', scope: good, instruction: '改克制' });
  const proposalId = turn.reply.proposalId;
  const result = service.applyProposal({ projectId: 'p1', threadId: t.threadId, proposalId, expectedItemRevision: 3 });
  assert.equal(result.itemRevision, 4);
  assert.equal(items.get('item_1').displayText, '0123456789这段动作更克制了。abcdefgh', '只有选区被替换');
  assert.equal(items.get('item_1').executionPrompt, 'EXEC v4');
  // 再应用已应用的提案 → 报错
  assert.throws(() => service.applyProposal({ projectId: 'p1', threadId: t.threadId, proposalId }), e => e.code === 'PROPOSAL_ALREADY_APPLIED');
});

test('applyProposal: 真实冲突报 EDIT_CONFLICT 并保留提案', async () => {
  const { service, items } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1' });
  const turn = await service.sendTurn({ projectId: 'p1', threadId: t.threadId, clientTurnId: 't3', scope: { type: 'wholeItem' }, instruction: '整体改写' });
  const proposalId = turn.reply.proposalId;
  items.get('item_1').itemRevision = 9; // 期间该条被别处更新
  assert.throws(() => service.applyProposal({ projectId: 'p1', threadId: t.threadId, proposalId, expectedItemRevision: 3 }), e => e.code === 'EDIT_CONFLICT');
  const thread = service.getThread({ projectId: 'p1', threadId: t.threadId });
  assert.ok(thread.messages.some(m => m.role === 'assistant' && m.payload.proposalId === proposalId), '提案保留，可按最新稿重新生成');
});

test('applyProposal: 选区拼接后全文不得为空；历史轮次可分页读取', async () => {
  const { service } = setup();
  const t = service.createThread({ projectId: 'p1', itemId: 'item_1' });
  service.model = async () => ({ ...REPLY, replacementDisplay: '' });
  await assert.rejects(() => service.sendTurn({ projectId: 'p1', threadId: t.threadId, instruction: '清空' }), e => ['CHAT_REPLY_NEEDS_REPLACEMENT', 'CHAT_REPLY_EMPTIES_TEXT'].includes(e.code));
  const thread = service.getThread({ projectId: 'p1', threadId: t.threadId });
  assert.ok(Array.isArray(thread.messages));
});
