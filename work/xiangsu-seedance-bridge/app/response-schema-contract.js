'use strict';
// Both public option spellings describe the same transport contract. Resolve
// before provider routing so switching a provider cannot discard the schema.
function normalize(options = {}) {
  const alias = options.responseJsonSchema;
  if (options.responseSchema || !alias || typeof alias !== 'object' || Array.isArray(alias)) return options;
  return { ...options, responseSchema: alias };
}
module.exports = { normalize };
