"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultPromptTemplates, PROMPT_LIBRARY_VERSION } = require("../app/prompt-library");

test("character video prompts require continuous speech for voice capture", () => {
  const prompts = defaultPromptTemplates();
  assert.match(PROMPT_LIBRARY_VERSION, /v9/);
  assert.match(prompts.characterVideo, /全程必须说话|不间断/);
  assert.match(prompts.characterVideo, /\{\{speechScript\}\}/);
  assert.match(prompts.hailuoCharacterVideo, /continuously speaks|Silence longer than 0.25/);
  assert.match(prompts.productAsset, /严禁凭空生成商品/);
  assert.match(prompts.scriptUnitGeneration, /站位锁定|前半段.*禁止.*带货|角色名：台词/);
  assert.match(prompts.continuationVideo, /严禁 A 人说 B 话|音频N/);
});
