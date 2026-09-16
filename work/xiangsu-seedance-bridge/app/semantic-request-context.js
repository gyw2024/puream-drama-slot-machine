'use strict';

// Scope the request, not the canonical source or its cache fingerprint. A batch
// needs every current appearance plus the nearest preceding/following appearance
// of each relevant physical object, not repeated full actions from the whole film.
function scopedPropContinuityLedger(source = {}, requestShots = []) {
  const shots = Array.isArray(source.shots) ? source.shots : [];
  const order = new Map(shots.map((shot, index) => [String(shot.shotId), index]));
  const requested = new Set(requestShots.map(shot => String(shot.shotId)));
  const indices = [...requested].map(id => order.get(id)).filter(Number.isInteger);
  const ledger = Array.isArray(source.propContinuityLedger) ? source.propContinuityLedger : [];
  // Unknown source ordering is not permission to discard continuity evidence.
  if (!indices.length || indices.length !== requested.size) return ledger;
  const relevant = new Set(requestShots.flatMap(shot => (shot.propBindings || []).map(binding => String(binding.propId))));
  for (const entry of ledger) if ((entry.appearances || []).some(row => requested.has(String(row.shotId)))) relevant.add(String(entry.propId));
  const props = Array.isArray(source.props) ? source.props : [];
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const prop of props) {
      const family = [prop.id, prop.parentId, ...(prop.containsMemberIds || [])].filter(Boolean).map(String);
      if (!family.some(id => relevant.has(id))) continue;
      for (const id of family) if (!relevant.has(id)) { relevant.add(id); expanded = true; }
    }
  }
  return ledger.filter(entry => relevant.has(String(entry.propId))).map(entry => {
    const appearances = Array.isArray(entry.appearances) ? entry.appearances : [];
    if (appearances.some(row => !order.has(String(row.shotId)))) return entry;
    const keep = new Set();
    for (const current of indices) {
      let previous = null, next = null;
      appearances.forEach((row, index) => {
        const at = order.get(String(row.shotId));
        if (requested.has(String(row.shotId))) keep.add(index);
        if (at < current && (previous === null || at > order.get(String(appearances[previous].shotId)))) previous = index;
        if (at > current && (next === null || at < order.get(String(appearances[next].shotId)))) next = index;
      });
      if (previous !== null) keep.add(previous);
      if (next !== null) keep.add(next);
    }
    return { ...entry, appearances: appearances.filter((_, index) => keep.has(index)) };
  });
}

module.exports = { scopedPropContinuityLedger };
