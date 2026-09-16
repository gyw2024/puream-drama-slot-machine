'use strict';
const VERSION='asset-source-and-presentation-v1';
const INSTRUCTION='ASSET EVIDENCE AUTHORITY: Preserve user-supplied identity, count, age, wardrobe, object geometry and intrinsic printing. canonicalAssetEvidence and unchanged original source establish story facts; visualDesign and analyzed description/descriptionEn are derived design proposals, not original quotations. Preserve their compatible identity details, but a generated crop/aspect-ratio sentence cannot override the current stage presentation. If the original source explicitly specifies an asset presentation, cite that actual original requirement and resolve its conflict; do not invent a user constraint from a generated design. Neutral identity design fields describe the person, not a camera layout; omit crop, frame ratio and panel layout from those fields. Author the complete image prompt using the current stage presentation. During review distinguish physical identity from reference presentation; review both using their actual authority. No automatic pass, no erased source facts, and no new people or props.';
const stages={
 character_intro:'One vertical three-quarter-length identity photograph, complete head and relaxed hands visible, plain #E9E9E9 background, closed mouth, no handheld story props. Preserve the exact source-defined person or ensemble count. No panels or collage.',
 character_sheet:'Four aligned full-body views: front, left 90 degrees, right 90 degrees, back. Same source-defined identity or ensemble in every view, plain #E9E9E9, closed mouths, no handheld story props.',
 scene_asset:'One 16:9 2x2 four-view empty location board: forward, reverse, left 45 degrees, right 45 degrees. Same fixed geometry; no live occupants or movable story props.',
 prop_asset:'Preserve source-defined physical identity and exact collection count, required support or mounts, and intrinsic printing. Digital content remains content without an invented carrier.',
 wardrobe_asset:'Preserve the linked character approved garments, colors, materials and layers. A vague name does not authorize a new outfit.'
};
stages.character_three_view=stages.character_sheet;
function packet(names){return {version:VERSION,instruction:INSTRUCTION,stages:Object.fromEntries([...new Set(names)].filter(s=>stages[s]).map(s=>[s,stages[s]]))};}
module.exports={VERSION,INSTRUCTION,packet};
