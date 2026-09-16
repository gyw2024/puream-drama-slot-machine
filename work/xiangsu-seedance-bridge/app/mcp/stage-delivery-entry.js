'use strict';
require(require('node:path').join(__dirname,'..','app.asar','app','mcp','stage-delivery-server.js')).main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
