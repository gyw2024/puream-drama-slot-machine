'use strict';
// WorkBuddy's StructuredOutput fallback parameter shape is {data: object}.
// Use that same envelope even when its session schema has initialized; the
// application still validates the actual inner stage schema after unwrapping.
function schema(inner){return {type:'object',additionalProperties:false,required:['data'],properties:{data:require('./typed-output-projection').transportSchema(inner)}};}
const instruction='WorkBuddy transport contract: invoke StructuredOutput with {"data": <the complete requested JSON object>}. data must be an object, never a JSON string. The stage responseSchema describes the INNER data object. This outer data wrapper is owned by the transport and is removed by the application. Preserve all inner required fields and exact source identities. No file, shell, network, MCP, desktop or delegation tools. Do not return a plan or progress notice.';
module.exports={schema,instruction};
