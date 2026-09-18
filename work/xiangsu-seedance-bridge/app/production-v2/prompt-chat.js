'use strict';
const crypto = require('node:crypto');
const { fail, hash, textHash, stableId, nonempty, integer } = require('./contracts');
const D = require('./domain');
const G = require('./prompt-edit-guard');

const REPLY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'assistantMessage'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['proposal', 'needs_decision']
    },
    assistantMessage: { type: 'string' },
    replacementDisplay: { type: 'string' },
    proposedExecutionPrompt: { type: 'string' },
    changeReasons: { type: 'array', items: { type: 'string' } },
    dependencyFindings: { type: 'array' }
  }
};

// No model call occurs in these transactions. prompt.chat.turn is handled by the one outbox worker.
class PromptChatService {
  constructor(options = {}) {
    if (options.repository) {
      this.repo = options.repository;
      this.db = options.repository.db;
      this.store = options.repository.store;
      if (typeof options.loadFactsInTransaction !== 'function') throw fail('CHAT_FACTS_ADAPTER_REQUIRED', 'No empty relatedFacts fallback');
      this.loadFacts = options.loadFactsInTransaction;
    } else {
      this.db = options.db;
      this.loadItem = options.loadItem;
      this.saveItem = options.saveItem;
      this.model = options.model;
      this.repo = null;
      this.store = null;
    }
    if (this.db) {
      try {
        const cols = new Set(this.db.prepare("PRAGMA table_info(prompt_chat_threads)").all().map(r => r.name));
        if (!cols.has('working_turn_id')) {
          this.db.prepare("ALTER TABLE prompt_chat_threads ADD COLUMN working_turn_id TEXT NOT NULL DEFAULT ''").run();
        }
      } catch {}
      try {
        this.db.prepare(`CREATE TABLE IF NOT EXISTS prompt_chat_turns(
          turn_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          client_turn_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          status TEXT NOT NULL,
          base_json TEXT NOT NULL,
          reply_json TEXT NOT NULL DEFAULT '{}',
          instruction TEXT NOT NULL,
          parent_turn_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(thread_id, client_turn_id)
        )`).run();
      } catch {}
    }
  }

  thread(projectId, threadId) {
    const t = this.db.prepare('SELECT * FROM prompt_chat_threads WHERE project_id=? AND thread_id=?').get(projectId, threadId);
    if (!t) throw fail('CHAT_THREAD_NOT_FOUND', threadId);
    return t;
  }

  message(t, role, clientTurnId, payload, at) {
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM prompt_chat_messages WHERE thread_id=?').get(t.thread_id).n;
    const id = stableId('msg');
    this.db.prepare('INSERT INTO prompt_chat_messages(message_id,thread_id,project_id,seq,role,client_turn_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, t.thread_id, t.project_id, seq, role, clientTurnId || '', JSON.stringify(payload), at);
    return id;
  }

  createThread({ projectId, itemId, commandId, expectedRevision, expectedItemRevision, actor }) {
    if (this.repo) {
      return this.repo.commitCommand({
        projectId, commandId, commandType: 'promptChat.createThread', expectedRevision, actor, payload: { itemId },
        mutate: (p, { at }) => {
          D.promptItem(p, itemId);
          const threadId = 'thread_' + crypto.randomUUID();
          return {
            project: p,
            result: { threadId, itemId },
            finalizeInTransaction: () => this.db.prepare('INSERT INTO prompt_chat_threads(thread_id,project_id,item_id,status,created_at,updated_at,working_turn_id) VALUES(?,?,?,?,?,?,?)').run(threadId, projectId, itemId, 'open', at, at, '')
          };
        }
      });
    }
    const item = this.loadItem ? this.loadItem(projectId, itemId) : null;
    if (!item) throw fail('ITEM_NOT_FOUND', itemId);
    const expRev = expectedItemRevision ?? expectedRevision;
    if (expRev != null && Number(item.itemRevision) !== Number(expRev)) {
      throw Object.assign(new Error('revision conflict'), { code: 'REVISION_CONFLICT' });
    }
    const threadId = 'thread_' + crypto.randomUUID();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO prompt_chat_threads(thread_id,project_id,item_id,status,created_at,updated_at,working_turn_id) VALUES(?,?,?,?,?,?,?)').run(threadId, projectId, itemId, 'open', at, at, '');
    return { threadId, itemId };
  }

  reserveTurn({ projectId, threadId, clientTurnId, instruction, scope = { type: 'wholeItem' }, parentTurnId = '', expectedItemRevision, expectedContentHash, actor }) {
    nonempty(clientTurnId, 'clientTurnId');
    nonempty(instruction, 'instruction');
    this.repo.authorize(actor, projectId, 'promptChat.sendTurn');
    const requestHash = hash({ projectId, threadId, clientTurnId, instruction, scope, parentTurnId, expectedItemRevision, expectedContentHash });
    return this.store.transaction(() => {
      const t = this.thread(projectId, threadId);
      const prior = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE thread_id=? AND client_turn_id=?').get(threadId, clientTurnId);
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail('CHAT_TURN_ID_REUSED', clientTurnId);
        return { turnId: prior.turn_id, operationId: prior.operation_id, status: prior.status, replayed: true };
      }
      if (t.status !== 'open') throw fail('CHAT_THREAD_CLOSED', threadId);
      const { project } = this.repo.getProjectInTransaction(projectId), item = D.promptItem(project, t.item_id);
      if ((item.itemRevision ?? 0) !== expectedItemRevision || D.itemHash(item) !== expectedContentHash) throw fail('EDIT_CONFLICT', 'Refresh applied text before starting another branch');
      let working = null;
      if (parentTurnId) {
        const parent = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE turn_id=? AND thread_id=?').get(parentTurnId, threadId);
        if (!parent || parent.status !== 'proposal_ready') throw fail('CHAT_PARENT_NOT_APPLICABLE', parentTurnId);
        const base = JSON.parse(parent.base_json), out = JSON.parse(parent.reply_json);
        G.assertApplicable(item, { status: parent.status, base, proposal: out.proposal, validation: out.validation });
        working = out.proposal;
      }
      const base = G.prepareBase(item, scope, working), facts = this.loadFacts(project, item);
      if (!facts?.sourceHash || !Array.isArray(facts.dialogueRows) || !Array.isArray(facts.references)) throw fail('CHAT_FACTS_MISSING', item.id);
      const turnId = stableId('turn'), at = this.repo.now();
      const history = this.db.prepare('SELECT role,payload_json FROM prompt_chat_messages WHERE thread_id=? ORDER BY seq DESC LIMIT 12').all(threadId).reverse().map(m => ({ role: m.role, payload: JSON.parse(m.payload_json) }));
      const input = { version: 'prompt-chat-r2', stage: 'prompt_edit', projectId, turnId, threadId, itemId: item.id, base, instruction, facts, history, parentTurnId };
      const inputHash = this.repo.saveInputInTransaction(projectId, 'prompt.chat.turn', input);
      const op = this.repo.enqueueOperationInTransaction({ projectId, kind: 'prompt.chat.turn', targetId: turnId, inputFingerprint: inputHash, effectClass: 'external', operationKey: `chat:${threadId}:${clientTurnId}`, payload: { turnId, inputHash } });
      this.db.prepare('INSERT INTO prompt_chat_turns(turn_id,project_id,thread_id,client_turn_id,request_hash,operation_id,status,base_json,reply_json,instruction,parent_turn_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(turnId, projectId, threadId, clientTurnId, requestHash, op.operationId, 'queued', JSON.stringify(base), '{}', instruction, parentTurnId, at, at);
      this.message(t, 'user', clientTurnId, { turnId, instruction, scope, parentTurnId }, at);
      return { turnId, operationId: op.operationId, status: 'queued', replayed: false };
    });
  }

  async sendTurn({ projectId, threadId, clientTurnId = '', scope = { type: 'wholeItem' }, instruction = '', actor = 'user' }) {
    nonempty(instruction, 'instruction');
    const t = this.thread(projectId, threadId);
    if (clientTurnId) {
      const prior = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE thread_id=? AND client_turn_id=?').get(threadId, clientTurnId);
      if (prior) {
        return { turnId: prior.turn_id, reply: JSON.parse(prior.reply_json), replayed: true };
      }
    }
    const item = this.loadItem ? this.loadItem(projectId, t.item_id) : null;
    if (!item) throw fail('ITEM_NOT_FOUND', t.item_id);

    const displayText = item.displayText || '';
    if (scope && scope.type === 'selection') {
      const actualSlice = displayText.slice(scope.startUtf16, scope.endUtf16);
      if (scope.selectedText !== actualSlice || (scope.baseTextHash && scope.baseTextHash !== textHash(displayText))) {
        throw Object.assign(new Error('selection mismatch'), { code: 'SELECTION_MISMATCH' });
      }
    }

    const at = new Date().toISOString();
    this.message(t, 'user', clientTurnId, { instruction, scope }, at);

    const reply = await this.model({
      messages: [{ role: 'user', content: instruction }]
    });

    if (reply.verdict === 'needs_decision') {
      if (reply.replacementDisplay || reply.proposedExecutionPrompt) {
        throw Object.assign(new Error('needs_decision cannot have replacement or execution prompt'), { code: 'CHAT_REPLY_CONTRADICTORY' });
      }
    } else if (reply.verdict === 'proposal') {
      if (!reply.proposedExecutionPrompt || !reply.proposedExecutionPrompt.trim()) {
        throw Object.assign(new Error('proposal execution prompt cannot be empty'), { code: 'CHAT_REPLY_EMPTY_EXECUTION' });
      }
      if (reply.replacementDisplay === '' || reply.replacementDisplay == null) {
        throw Object.assign(new Error('replacement display cannot be empty'), { code: 'CHAT_REPLY_NEEDS_REPLACEMENT' });
      }
      let fullTextAfter = '';
      if (scope && scope.type === 'selection') {
        fullTextAfter = displayText.slice(0, scope.startUtf16) + reply.replacementDisplay + displayText.slice(scope.endUtf16);
      } else {
        fullTextAfter = reply.replacementDisplay;
      }
      if (!fullTextAfter.trim()) {
        throw Object.assign(new Error('replacement empties text'), { code: 'CHAT_REPLY_EMPTIES_TEXT' });
      }
      reply.fullTextAfter = fullTextAfter;
    }

    const turnId = stableId('turn');
    const proposalId = reply.verdict === 'proposal' ? 'prop_' + crypto.randomUUID() : null;
    if (proposalId) reply.proposalId = proposalId;

    this.db.prepare('INSERT INTO prompt_chat_turns(turn_id,project_id,thread_id,client_turn_id,request_hash,operation_id,status,base_json,reply_json,instruction,parent_turn_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      turnId, projectId, threadId, clientTurnId, '', '', reply.verdict === 'proposal' ? 'proposal_ready' : 'needs_decision',
      JSON.stringify({ itemRevision: item.itemRevision, scope, displayText }), JSON.stringify(reply), instruction, '', at, at
    );

    this.message(t, 'assistant', clientTurnId, reply, at);

    return { turnId, reply, replayed: false };
  }

  commitOutcomeInTransaction(projectId, turnId, outcome) {
    const row = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE project_id=? AND turn_id=?').get(projectId, turnId);
    if (!row || ['cancelled', 'discarded', 'applied'].includes(row.status)) throw fail('CHAT_TURN_TERMINAL', turnId);
    const t = this.thread(projectId, row.thread_id), base = JSON.parse(row.base_json);
    const proposal = G.buildProposal(base, outcome.reply);
    if (hash(proposal) !== hash(outcome.proposal)) throw fail('CHAT_PROPOSAL_MISMATCH', turnId);
    const status = proposal ? 'proposal_ready' : 'needs_decision';
    const stored = { reply: outcome.reply, proposal, validation: outcome.validation };
    if (proposal && (outcome.validation?.valid !== true || outcome.validation.proposalHash !== hash(proposal) || outcome.validation.baseContentHash !== base.baseContentHash)) throw fail('CHAT_VALIDATION_REQUIRED', turnId);
    const at = this.repo.now();
    this.db.prepare('UPDATE prompt_chat_turns SET status=?,reply_json=?,updated_at=? WHERE turn_id=?').run(status, JSON.stringify(stored), at, turnId);
    if (proposal) this.db.prepare('UPDATE prompt_chat_threads SET working_turn_id=?,updated_at=? WHERE thread_id=?').run(turnId, at, t.thread_id);
    this.message(t, 'assistant', row.client_turn_id, { turnId, ...stored, status }, at);
    this.repo.appendEventInTransaction(projectId, `prompt.chat.${status}`, { turnId, threadId: t.thread_id }, at);
  }

  applyProposal({ projectId, threadId, proposalId, turnId, commandId, expectedItemRevision, actor }) {
    if (this.repo && turnId) {
      this.repo.authorize(actor, projectId, 'promptChat.applyProposal');
      const load = () => {
        const t = this.thread(projectId, threadId), r = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE project_id=? AND thread_id=? AND turn_id=?').get(projectId, threadId, turnId);
        if (!r) throw fail('CHAT_TURN_NOT_FOUND', turnId);
        return { t, r, out: JSON.parse(r.reply_json), base: JSON.parse(r.base_json) };
      };
      return this.repo.commitCommand({
        projectId, commandId, commandType: 'promptChat.applyProposal', actor, payload: { threadId, turnId },
        condition: p => {
          const { t, r, out, base } = load();
          G.assertApplicable(D.promptItem(p, t.item_id), { status: r.status, base, proposal: out.proposal, validation: out.validation });
        },
        mutate: (p, { at }) => {
          const { t, out, base } = load();
          const result = D.applyPromptEdit(p, { itemId: t.item_id, baseRevision: base.baseItemRevision, baseHash: base.baseContentHash, ...out.proposal, at });
          return {
            project: p, result, events: [{ type: 'prompt.chat.applied', payload: { turnId, ...result } }],
            finalizeInTransaction: () => {
              this.db.prepare("UPDATE prompt_chat_turns SET status='applied',updated_at=? WHERE turn_id=? AND status='proposal_ready'").run(at, turnId);
              this.db.prepare("UPDATE prompt_chat_threads SET working_turn_id='',updated_at=? WHERE thread_id=?").run(at, threadId);
              this.message(t, 'system', '', { event: 'applied', turnId, itemRevision: result.itemRevision }, at);
            }
          };
        }
      });
    }

    const t = this.thread(projectId, threadId);
    const turns = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE thread_id=?').all(threadId);
    let targetTurn = null;
    let targetReply = null;
    for (const r of turns) {
      const parsed = JSON.parse(r.reply_json || '{}');
      if (parsed.proposalId === proposalId) {
        targetTurn = r;
        targetReply = parsed;
        break;
      }
    }
    if (!targetTurn) throw fail('PROPOSAL_NOT_FOUND', proposalId);
    if (targetTurn.status === 'applied') {
      throw Object.assign(new Error('proposal already applied'), { code: 'PROPOSAL_ALREADY_APPLIED' });
    }

    const item = this.loadItem(projectId, t.item_id);
    if (!item) throw fail('ITEM_NOT_FOUND', t.item_id);
    if (expectedItemRevision != null && Number(item.itemRevision) !== Number(expectedItemRevision)) {
      throw Object.assign(new Error('edit conflict'), { code: 'EDIT_CONFLICT' });
    }

    const at = new Date().toISOString();
    const saveRes = this.saveItem(projectId, item.itemId || item.id, {
      displayText: targetReply.fullTextAfter,
      executionPrompt: targetReply.proposedExecutionPrompt,
      expectedItemRevision: item.itemRevision
    });

    this.db.prepare("UPDATE prompt_chat_turns SET status='applied',updated_at=? WHERE turn_id=?").run(at, targetTurn.turn_id);
    this.message(t, 'system', '', { event: 'applied', proposalId, itemRevision: saveRes.itemRevision }, at);

    return saveRes;
  }

  cancelTurn({ projectId, threadId, turnId, actor }) {
    this.repo.authorize(actor, projectId, 'promptChat.cancelTurn');
    return this.store.transaction(() => {
      const t = this.thread(projectId, threadId), r = this.db.prepare('SELECT * FROM prompt_chat_turns WHERE thread_id=? AND turn_id=?').get(threadId, turnId);
      if (!r) throw fail('CHAT_TURN_NOT_FOUND', turnId);
      if (r.status === 'applied') throw fail('CHAT_ALREADY_APPLIED', 'Use a new undo command, not cancellation');
      if (['cancelled', 'discarded'].includes(r.status)) return { cancelled: r.status === 'cancelled', status: r.status };
      const at = this.repo.now();
      this.db.prepare("UPDATE prompt_chat_turns SET status='cancelled',updated_at=? WHERE turn_id=?").run(at, turnId);
      this.db.prepare("UPDATE operation_outbox SET cancel_requested_at=?,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updated_at=? WHERE operation_id=? AND status NOT IN ('completed','cancelled','stale')").run(at, at, r.operation_id);
      this.db.prepare("UPDATE prompt_chat_threads SET working_turn_id='' WHERE thread_id=? AND working_turn_id=?").run(threadId, turnId);
      this.message(t, 'system', '', { event: 'cancelled', turnId }, at);
      this.repo.appendEventInTransaction(projectId, 'operation.cancel_requested', { operationId: r.operation_id, turnId }, at);
      return { cancelled: true, operationId: r.operation_id };
    });
  }

  discardProposal({ projectId, threadId, turnId, actor }) {
    this.repo.authorize(actor, projectId, 'promptChat.discardProposal');
    return this.store.transaction(() => {
      const t = this.thread(projectId, threadId), r = this.db.prepare('SELECT status FROM prompt_chat_turns WHERE thread_id=? AND turn_id=?').get(threadId, turnId);
      if (!r || !['proposal_ready', 'discarded'].includes(r.status)) throw fail('PROPOSAL_NOT_DISCARDABLE', turnId);
      if (r.status === 'discarded') return { discarded: true, replayed: true };
      const at = this.repo.now();
      this.db.prepare("UPDATE prompt_chat_turns SET status='discarded',updated_at=? WHERE turn_id=?").run(at, turnId);
      this.db.prepare("UPDATE prompt_chat_threads SET working_turn_id='' WHERE thread_id=? AND working_turn_id=?").run(threadId, turnId);
      this.message(t, 'system', '', { event: 'discarded', turnId }, at);
      return { discarded: true, replayed: false };
    });
  }

  getThread({ projectId, threadId, afterSeq = 0, limit = 50, actor }) {
    if (this.repo) {
      this.repo.authorize(actor, projectId, 'promptChat.read');
      integer(afterSeq, 'afterSeq');
      integer(limit, 'limit', 1, 100);
    }
    const t = this.thread(projectId, threadId);
    const rows = this.db.prepare('SELECT * FROM prompt_chat_messages WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?').all(t.thread_id, afterSeq, limit + 1);
    const hasMore = rows.length > limit, shown = rows.slice(0, limit);
    return {
      threadId,
      workingTurnId: t.working_turn_id || null,
      messages: shown.map(r => ({ messageId: r.message_id, seq: r.seq, role: r.role, payload: JSON.parse(r.payload_json) })),
      nextSeq: shown.at(-1)?.seq ?? afterSeq,
      hasMore
    };
  }
}

module.exports = { PromptChatService, REPLY_SCHEMA };
