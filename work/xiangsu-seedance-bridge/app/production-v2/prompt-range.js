'use strict';
// production-v2 prompt range — appendix B reference-code/prompt-range.cjs.
// UTF-16 textarea selection capture and safe replacement with double checks:
// whole-text hash + exact selected source text. Handles CJK, emoji surrogate
// pairs and rejects empty selections explicitly.
const { fail, textHash } = require('./contracts.js');
function boundary(text, index) {
  if (!Number.isInteger(index) || index < 0 || index > text.length) return false;
  if (index === 0 || index === text.length) return true;
  const a = text.charCodeAt(index - 1), b = text.charCodeAt(index);
  return !(a >= 0xD800 && a <= 0xDBFF && b >= 0xDC00 && b <= 0xDFFF);
}
function capture(text, start = 0, end = text.length) {
  if (typeof text !== 'string' || !boundary(text, start) || !boundary(text, end) || start > end) throw fail('INVALID_SELECTION', 'Invalid UTF-16 selection');
  if (start === end) throw fail('EMPTY_SELECTION', 'Select text or explicitly choose the entire item');
  return { baseHash: textHash(text), startUtf16: start, endUtf16: end, selectedText: text.slice(start, end) };
}
function apply(text, selection, replacement) {
  if (typeof replacement !== 'string') throw fail('INVALID_REPLACEMENT', 'Replacement must be text');
  if (textHash(text) !== selection.baseHash) throw fail('EDIT_CONFLICT', 'Current item changed; preserve proposal and rebase');
  const checked = capture(text, selection.startUtf16, selection.endUtf16);
  if (checked.selectedText !== selection.selectedText) throw fail('SELECTION_MISMATCH', 'Selected source text changed');
  return text.slice(0, selection.startUtf16) + replacement + text.slice(selection.endUtf16);
}
module.exports = { capture, apply, boundary };
