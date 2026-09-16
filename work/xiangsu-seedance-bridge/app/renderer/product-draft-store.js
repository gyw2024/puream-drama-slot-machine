(function(root) {
  'use strict';
  function createProductDraftStore({storage, save, onSaved = () => {}, onError = () => {}, delay = 400, retryDelay = 2500}) {
    const entries = new Map(), latest = new Map();
    const key = id => 'puream:product-draft:v1:' + id;
    function entry(id) {
      if (!entries.has(id)) {
        let fields = {};
        try { fields = JSON.parse(storage.getItem(key(id)) || '{}'); } catch {}
        entries.set(id, {fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}, timer: null, running: null});
      }
      return entries.get(id);
    }
    function journal(id, e) {
      try {
        if (Object.keys(e.fields).length) storage.setItem(key(id), JSON.stringify(e.fields));
        else storage.removeItem(key(id));
      } catch (error) { onError(error, id); }
    }
    function schedule(id, wait = delay) {
      const e = entry(id);
      clearTimeout(e.timer);
      e.timer = setTimeout(() => { e.timer = null; flush(id).catch(() => {}); }, wait);
    }
    function edit(id, field, value) {
      if (!id) return;
      const e = entry(id);
      e.fields[field] = String(value);
      if (field === 'sellingPoints') e.fields.description = String(value);
      journal(id, e);
      schedule(id);
    }
    function apply(project) {
      if (!project?.id) return project;
      const e = entry(project.id), prior = latest.get(project.id);
      const product = prior && String(project.updatedAt || '') < String(prior.updatedAt || '') ? prior.product : project.product;
      if (Object.keys(e.fields).length && !e.timer && !e.running) schedule(project.id);
      return {...project, product: {...product, ...e.fields}};
    }
    function flush(id) {
      if (!id) return Promise.resolve();
      const e = entry(id);
      clearTimeout(e.timer); e.timer = null;
      if (e.running) return e.running;
      if (!Object.keys(e.fields).length) return Promise.resolve();
      e.running = (async () => {
        while (Object.keys(e.fields).length) {
          const sent = {...e.fields};
          const result = await save(id, {product: sent, activitySummary: '自动保存商品信息'});
          if (!result?.ok) throw new Error(result?.message || '商品信息暂未写入项目');
          latest.set(id, result.project);
          for (const field of Object.keys(sent)) if (e.fields[field] === sent[field]) delete e.fields[field];
          journal(id, e);
          onSaved(apply(result.project), id);
        }
      })().catch(error => { onError(error, id); schedule(id, retryDelay); throw error; })
        .finally(() => { e.running = null; if (!Object.keys(e.fields).length) { clearTimeout(e.timer); e.timer = null; } });
      return e.running;
    }
    return {edit, apply, flush};
  }
  if (typeof module === 'object' && module.exports) module.exports = {createProductDraftStore};
  else root.createProductDraftStore = createProductDraftStore;
})(typeof window === 'object' ? window : globalThis);
