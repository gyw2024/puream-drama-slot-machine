'use strict';
// production-v2/text-planner (T07 / §7.2 / §7.3 / §7.5).
// Pre-production task graph, shot/asset batching, and text completeness verification.
// Enforces 20-minute soft target budget, bounded repair attempts, and ensures
// no dialogue lines or scene requirements are dropped.
const { fail, exactCoverage, assertUniqueIds } = require('./contracts.js');
const { assertDag } = require('./dependency-graph.js');
const { createRepairBudget } = require('./budget.js');

const DEFAULT_SHOT_BATCH_SIZE = 5;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_PREPRODUCTION_TARGET_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Creates batches of items up to maxBatchSize.
 */
function createBatches(items = [], maxBatchSize = DEFAULT_SHOT_BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < items.length; i += maxBatchSize) {
    batches.push(items.slice(i, i + maxBatchSize));
  }
  return batches;
}

/**
 * Builds the preproduction DAG structure and verifies there are no dependency cycles.
 */
function buildPreproductionTaskGraph(project) {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  const characters = Array.isArray(project?.characters) ? project.characters : [];
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const props = Array.isArray(project?.assetLibraries?.props) ? project.assetLibraries.props : [];

  const edges = [];
  // Facts / Script -> Assets
  for (const char of characters) {
    edges.push(['task:script', `task:asset:${char.id}`]);
  }
  for (const scene of scenes) {
    edges.push(['task:script', `task:asset:${scene.id}`]);
  }
  for (const prop of props) {
    edges.push(['task:script', `task:asset:${prop.id}`]);
  }

  // Assets -> Shots that reference them
  for (const shot of shots) {
    edges.push(['task:script', `task:shot:${shot.id}`]);
    const participants = Array.isArray(shot.participants) ? shot.participants : [];
    for (const charId of participants) {
      edges.push([`task:asset:${charId}`, `task:shot:${shot.id}`]);
    }
    if (shot.sceneId || shot.scene) {
      edges.push([`task:asset:${shot.sceneId || shot.scene}`, `task:shot:${shot.id}`]);
    }
    // Shots -> Final continuity
    edges.push([`task:shot:${shot.id}`, 'task:continuity']);
  }

  assertDag(edges);
  return { edges, shotCount: shots.length, assetCount: characters.length + scenes.length + props.length };
}

/**
 * Verifies business completeness of text preproduction before marking textComplete = true.
 */
function verifyTextCompleteness(project, promptItems = []) {
  const shots = Array.isArray(project?.shots) ? project.shots : [];
  if (!shots.length) {
    throw fail('TEXT_COMPLETENESS_EMPTY', 'No shots found in project');
  }

  // 1. Dialogue coverage
  const expectedDialogueIds = [];
  for (const shot of shots) {
    const turns = Array.isArray(shot.dialogue) ? shot.dialogue : [];
    for (const turn of turns) {
      if (turn.sourceDialogueId) expectedDialogueIds.push(String(turn.sourceDialogueId));
      else if (turn.id) expectedDialogueIds.push(String(turn.id));
    }
    if (Array.isArray(shot.sourceDialogueIds)) {
      for (const id of shot.sourceDialogueIds) {
        if (!expectedDialogueIds.includes(String(id))) expectedDialogueIds.push(String(id));
      }
    }
  }

  const deliveredDialogueIds = [];
  const promptItemsById = new Map((promptItems || []).map(item => [String(item.id), item]));
  const missingPrompts = [];

  for (const shot of shots) {
    const shotItem = promptItemsById.get(String(shot.id))
      || (promptItems || []).find(item => item.entityId === String(shot.id) && item.stage === 'shot_video');
    if (!shotItem) {
      missingPrompts.push(String(shot.id));
    } else {
      if (Array.isArray(shotItem.dialogueIds)) {
        for (const id of shotItem.dialogueIds) deliveredDialogueIds.push(String(id));
      }
    }
  }

  if (missingPrompts.length) {
    throw fail('PROMPT_ITEMS_INCOMPLETE', `Missing prompts for shots: ${missingPrompts.slice(0, 8).join(', ')}`, {
      missingShotIds: missingPrompts
    });
  }

  if (expectedDialogueIds.length) {
    const coverage = exactCoverage(expectedDialogueIds, deliveredDialogueIds);
    if (!coverage.ok) {
      // Return detailed coverage report
      return {
        complete: false,
        coverage,
        missingShots: missingPrompts
      };
    }
  }

  return {
    complete: true,
    shotCount: shots.length,
    promptCount: promptItems.length
  };
}

class TextPlanner {
  constructor({ batchSize = DEFAULT_SHOT_BATCH_SIZE, concurrency = DEFAULT_MAX_CONCURRENCY, targetMs = DEFAULT_PREPRODUCTION_TARGET_MS } = {}) {
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.targetMs = targetMs;
  }

  createPlan(project) {
    const shots = Array.isArray(project?.shots) ? project.shots : [];
    const shotBatches = createBatches(shots, this.batchSize);
    const graph = buildPreproductionTaskGraph(project);
    const budget = createRepairBudget({ maxRunRepairs: 12 });

    return {
      shotBatches,
      graph,
      budget,
      targetMs: this.targetMs,
      concurrency: this.concurrency,
      totalShots: shots.length
    };
  }

  verify(project, promptItems) {
    return verifyTextCompleteness(project, promptItems);
  }
}

module.exports = {
  TextPlanner,
  buildPreproductionTaskGraph,
  createBatches,
  verifyTextCompleteness,
  DEFAULT_SHOT_BATCH_SIZE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PREPRODUCTION_TARGET_MS
};
