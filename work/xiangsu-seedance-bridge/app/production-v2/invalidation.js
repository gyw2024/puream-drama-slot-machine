'use strict';
// T12 / §11.5: dependency invalidation and local re-execution authorization.
// User edits invalidate ONLY the affected closure — results are marked stale,
// never deleted. Each change kind maps to an exact table row from the spec:
//   改未使用资产描述      → 该资产提示词/候选计划        （不重写剧本）
//   换被 N 镜引用的人物图 → N 镜新 submission 输入+需授权（不删旧视频）
//   改单镜动作提示词      → 该镜提示词版本+该镜媒体任务+后期当前性（不重开整稿 gate）
//   调换两镜顺序          → 相邻连续性+EDL+粗剪当前性    （不改对白 ID）
//   只改音效增益          → 混音预览+音轨导出            （不重生视频）
//   选用已生成的另一个视频 → 该镜 selected hash+粗剪     （不调用文本 Agent）
// Graph nodes carry content hashes; a cycle is a PROGRAM error and pauses.
const graph = require('./dependency-graph.js');
const { fail } = require('./contracts.js');

function shotAssetEdges(project) {
  const edges = [];
  for (const shot of project.shots || []) {
    for (const participant of shot.participants || []) edges.push([`asset:${participant}`, `shot_prompt:${shot.id}`]);
    for (const ref of shot.references || []) {
      const assetId = typeof ref === 'string' ? ref : ref.entityId || ref.assetId;
      if (assetId) edges.push([`asset:${assetId}`, `shot_prompt:${shot.id}`]);
    }
    edges.push([`shot_prompt:${shot.id}`, `shot_video:${shot.id}`]);
    edges.push([`shot_video:${shot.id}`, 'roughcut:current']);
  }
  edges.push(['shot_order:current', 'roughcut:current']);
  for (const cue of project.sfxCues || []) {
    edges.push([`sfx:${cue.shotId || cue.id || ''}`, 'sfx_preview:current']);
  }
  return edges;
}

/**
 * invalidate(project, change) → { stale: [...], needsAuthorization: [...],
 * untouched: [...], preserved: {...} }
 * Marks downstream nodes stale on the project and returns the authorization
 * scope the user must approve for regeneration. It NEVER deletes media or
 * re-opens the initial whole-script gate.
 */
function invalidate(project, change) {
  const edges = shotAssetEdges(project);
  graph.assertDag(edges.filter(([a, b]) => !String(a).startsWith('shot_order') && a !== b));
  const referencedShots = assetId => (project.shots || [])
    .filter(shot => (shot.participants || []).map(String).includes(String(assetId))
      || (shot.references || []).some(ref => (typeof ref === 'string' ? ref : ref.entityId || ref.assetId) === String(assetId)))
    .map(shot => String(shot.id));
  const stale = new Set();
  const needsAuthorization = [];
  const untouched = [];

  switch (change.kind) {
    case 'asset_description_changed': {
      const refs = referencedShots(change.assetId);
      stale.add(`asset_prompt:${change.assetId}`);
      if (refs.length) {
        for (const shotId of refs) { stale.add(`shot_prompt:${shotId}`); needsAuthorization.push({ intent: 'asset regeneration', assetId, shotIds: refs }); }
      } else {
        untouched.push('未引用资产：只失效该资产的提示词/候选生成计划，不影响任何分镜');
      }
      break;
    }
    case 'asset_candidate_replaced': {
      const refs = referencedShots(change.assetId);
      for (const shotId of refs) {
        stale.add(`shot_input:${shotId}`);
        needsAuthorization.push({ intent: 'video regeneration', shotId });
        // 旧视频保留：只标记 reference_stale，不删除
        const shot = (project.shots || []).find(s => String(s.id) === shotId);
        if (shot) shot.referenceStale = true;
      }
      break;
    }
    case 'shot_prompt_changed': {
      stale.add(`shot_prompt:${change.shotId}`);
      stale.add(`shot_video:${change.shotId}`);
      needsAuthorization.push({ intent: 'video regeneration', shotId: change.shotId });
      untouched.push('初次整稿批准 gate 不受影响；其他镜头不受影响');
      break;
    }
    case 'shot_order_changed': {
      stale.add('boundary_continuity:current');
      stale.add('roughcut:current');
      untouched.push('对白 ID 不变；不受影响的媒体文件保留');
      break;
    }
    case 'sfx_gain_changed': {
      stale.add('sfx_preview:current');
      stale.add('audio_export:current');
      untouched.push('不重新生成任何视频');
      break;
    }
    case 'shot_video_selected': {
      stale.add(`shot_video_selection:${change.shotId}`);
      stale.add('roughcut:current');
      untouched.push('不调用文本 Agent；不重开整稿确认');
      break;
    }
    default:
      throw fail('INVALIDATION_KIND_UNKNOWN', `Unknown invalidation kind: ${change.kind}`);
  }

  // Cross-check with the closure: everything downstream of the changed nodes
  // must appear in the stale set (defense against a missed table row).
  const changedIds = [...stale].filter(node => !node.startsWith('boundary_') && !node.startsWith('audio_'));
  for (const node of graph.affected(changedIds, edges)) stale.add(node);

  project.staleNodes ||= {};
  for (const node of stale) project.staleNodes[node] = { at: change.at || null, kind: change.kind };
  return {
    stale: [...stale],
    needsAuthorization,
    untouched,
    preserved: { mediaDeleted: 0, dialogueIdsChanged: 0, initialGateReopened: false }
  };
}

module.exports = { invalidate, shotAssetEdges };
