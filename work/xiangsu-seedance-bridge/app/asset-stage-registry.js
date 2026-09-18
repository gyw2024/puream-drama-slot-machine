'use strict';
// 单一来源的资产阶段注册表（GPT §9.4）。
//
// 背景：此前有十余个模块各自手抄一份 stage 名单，子集互不相同。
// 结果是「新增一个合法 stage 只有护照模块忘了更新」，未知道 stage 被误判为
// 不合规或反之被静默放行。
//
// 本模块是唯一权威定义。其它模块如确实需要子集，应从本表派生，不得再手抄字面量。
//
// 分族说明（保持与既有语义一致）：
//   · IMAGE_ASSET_STAGES   —— 静态图片类资产（人物/场景/道具/服装/商品）
//   · CHARACTER_IMAGE_STAGES —— 人物静态参考图
//   · VOICE_ASSET_STAGES   —— 音色样本
//   · VIDEO_ASSET_STAGES   —— 视频类资产
//   · STORYBOARD_STAGES    —— 分镜/关键帧类
const VERSION = 'asset-stage-registry-v1';

// 已知的静态图片资产阶段。
const IMAGE_ASSET_STAGES = Object.freeze([
  'character_intro',
  'character_sheet',
  'character_three_view',
  'scene_asset',
  'prop_asset',
  'wardrobe_asset',
  'product_asset',
  'storyboard_still',
  'storyboard_sheet'
]);

// 人物参考图子集。
const CHARACTER_IMAGE_STAGES = Object.freeze([
  'character_intro',
  'character_sheet',
  'character_three_view'
]);

// 需要固定 #E9E9E9 纯色背景并做背景校验的人物四视图阶段。
const CHARACTER_SHEET_STAGES = Object.freeze(['character_sheet', 'character_three_view']);

// 音色样本。
const VOICE_ASSET_STAGES = Object.freeze(['character_voice', 'voice_asset']);

// 视频类资产。
const VIDEO_ASSET_STAGES = Object.freeze(['character_video', 'shot_video']);

// 分镜/关键帧类。storyboard_ 前缀族同样视为已知（见 isKnownStage）。
const STORYBOARD_STAGES = Object.freeze(['storyboard_still', 'storyboard_sheet']);

// 允许的 storyboard 前缀，用于接收后加的 storyboard_keyframe 之类族成员。
const STORYBOARD_PREFIX = 'storyboard_';

const ALL_ASSET_STAGES = Object.freeze([...new Set([
  ...IMAGE_ASSET_STAGES,
  ...CHARACTER_SHEET_STAGES,
  ...VOICE_ASSET_STAGES,
  ...VIDEO_ASSET_STAGES,
  ...STORYBOARD_STAGES
])]);

const ALL_ASSET_STAGES_SET = new Set(ALL_ASSET_STAGES);

// 是否已知资产阶段。
function isKnownAssetStage(stage = '') {
  const value = String(stage || '');
  if (!value) return false;
  if (ALL_ASSET_STAGES_SET.has(value)) return true;
  return value.startsWith(STORYBOARD_PREFIX);
}

// 是否人物纯色背景四视图阶段。
function requiresUniformCharacterBackground(stage = '') {
  return CHARACTER_SHEET_STAGES.includes(String(stage || ''));
}

module.exports = {
  VERSION,
  STORYBOARD_PREFIX,
  IMAGE_ASSET_STAGES,
  CHARACTER_IMAGE_STAGES,
  CHARACTER_SHEET_STAGES,
  VOICE_ASSET_STAGES,
  VIDEO_ASSET_STAGES,
  STORYBOARD_STAGES,
  ALL_ASSET_STAGES,
  isKnownAssetStage,
  requiresUniformCharacterBackground
};
