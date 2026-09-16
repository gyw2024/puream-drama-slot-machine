const test=require('node:test'),assert=require('node:assert/strict');
const {scriptWorkflowScope}=require('../app/workbench-status');
test('original, upload and adaptation show writing, reviewing and repairing as script work',()=>{
 for(const operation of ['idea_script','analyze_script','script_adaptation'])for(const stage of ['shot_screenplay_write','shot_screenplay_review','shot_screenplay_repair'])assert.deepEqual(scriptWorkflowScope({operation,stage,targetId:'script'}),{scriptOperation:true,inScriptStage:true});
 assert.deepEqual(scriptWorkflowScope({operation:'pipeline_from_stage',targetId:'script',stage:'shot_screenplay_review'}),{scriptOperation:true,inScriptStage:true});
 assert.deepEqual(scriptWorkflowScope({operation:'full_pipeline',stage:'shot_videos'}),{scriptOperation:true,inScriptStage:false});
 assert.deepEqual(scriptWorkflowScope({operation:'topic_ideation',stage:'topics'}),{scriptOperation:false,inScriptStage:false});
});
