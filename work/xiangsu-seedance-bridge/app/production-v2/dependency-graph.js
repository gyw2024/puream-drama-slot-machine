'use strict';
// production-v2 dependency graph — appendix B reference-code/dependency-graph.cjs.
// Transitive affected-closure over ordered edges; cycle detection for task
// graphs. Nodes must carry versions or content hashes at the call site.
const { fail } = require('./contracts.js');
function affected(changedIds, edges) {
  const map = new Map();
  for (const [upstream, downstream] of edges) {
    if (upstream === downstream) throw fail('SELF_DEPENDENCY', 'Self dependency');
    const list = map.get(upstream) || []; list.push(downstream); map.set(upstream, list);
  }
  const found = new Set(changedIds), queue = [...found];
  for (let i = 0; i < queue.length; i++) for (const child of map.get(queue[i]) || []) if (!found.has(child)) { found.add(child); queue.push(child); }
  return [...found];
}
function assertDag(edges) {
  const children = new Map(), indegree = new Map();
  for (const [a, b] of edges) { if (!indegree.has(a)) indegree.set(a, 0); indegree.set(b, (indegree.get(b) || 0) + 1); children.set(a, [...(children.get(a) || []), b]); }
  const q = [...indegree].filter(([, n]) => n === 0).map(([id]) => id); let count = 0;
  for (let i = 0; i < q.length; i++) { count++; for (const b of children.get(q[i]) || []) { const n = indegree.get(b) - 1; indegree.set(b, n); if (!n) q.push(b); } }
  if (count !== indegree.size) throw fail('DEPENDENCY_CYCLE', 'Task graph contains a cycle'); return true;
}
module.exports = { affected, assertDag };
