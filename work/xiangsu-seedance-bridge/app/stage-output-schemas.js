'use strict';
const schemas={
  "finalBlocks": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "shotId",
            "openingEn",
            "openingZh",
            "secondCameraEn",
            "secondCameraZh",
            "turns",
            "endingEn",
            "endingZh",
            "summaryEn",
            "soundscapeEn"
          ],
          "properties": {
            "shotId": {
              "type": "string",
              "minLength": 1
            },
            "openingEn": {
              "type": "string",
              "minLength": 1
            },
            "openingZh": {
              "type": "string",
              "minLength": 1
            },
            "secondCameraEn": {
              "type": "string",
              "minLength": 1
            },
            "secondCameraZh": {
              "type": "string",
              "minLength": 1
            },
            "turns": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "sourceDialogueId",
                  "directionEn",
                  "directionZh"
                ],
                "properties": {
                  "sourceDialogueId": {
                    "type": "string",
                    "minLength": 1
                  },
                  "directionEn": {
                    "type": "string",
                    "minLength": 1
                  },
                  "directionZh": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            },
            "endingEn": {
              "type": "string",
              "minLength": 1
            },
            "endingZh": {
              "type": "string",
              "minLength": 1
            },
            "summaryEn": {
              "type": "string",
              "minLength": 1
            },
            "soundscapeEn": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      }
    }
  },
  "assetDesign": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "descriptionZh",
            "descriptionEn",
            "gender",
            "ageBand",
            "castingTier",
            "designChoices"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "descriptionZh": {
              "type": "string",
              "minLength": 1
            },
            "descriptionEn": {
              "type": "string",
              "minLength": 1
            },
            "gender": {
              "type": "string"
            },
            "ageBand": {
              "type": "string"
            },
            "castingTier": {
              "type": "string"
            },
            "designChoices": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  },
  "inventory": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "objects",
      "coverage"
    ],
    "properties": {
      "objects": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "aliases",
            "role",
            "description",
            "reason",
            "parentName",
            "sourceEvidenceIds",
            "occurrences"
          ],
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1
            },
            "aliases": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "role": {
              "type": "string",
              "enum": [
                "core",
                "background"
              ]
            },
            "description": {
              "type": "string",
              "minLength": 1
            },
            "reason": {
              "type": "string",
              "minLength": 1
            },
            "parentName": {
              "type": "string"
            },
            "sourceEvidenceIds": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1
              }
            },
            "occurrences": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "shotId",
                  "visibility",
                  "evidenceId"
                ],
                "properties": {
                  "shotId": {
                    "type": "string",
                    "minLength": 1
                  },
                  "visibility": {
                    "type": "string",
                    "enum": [
                      "visible",
                      "stored"
                    ]
                  },
                  "evidenceId": {
                    "type": "string",
                    "minLength": 1
                  }
                }
              }
            }
          }
        }
      },
      "coverage": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "declarationId",
            "assetNames",
            "disposition",
            "reason"
          ],
          "properties": {
            "declarationId": {
              "type": "string",
              "minLength": 1
            },
            "assetNames": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "disposition": {
              "type": "string",
              "enum": [
                "set_dressing",
                "incidental",
                "state_or_part",
                "product"
              ]
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      }
    }
  }
};
const final=schemas.finalBlocks.properties.items.items.properties;
// Optional Chinese mirrors are display-only, not alternate executable fields.
final.summaryZh={type:"string"};final.soundscapeZh={type:"string"};
for(const [key,max] of Object.entries({openingEn:20,secondCameraEn:12,endingEn:20})){final[key].pattern="^\\s*(?:\\S+\\s+){0,"+(max-1)+"}\\S+\\s*$";}
final.turns.items.properties.directionEn.pattern="^\\s*(?:\\S+\\s+){0,27}\\S+\\s*$";
module.exports=Object.fromEntries(Object.entries(schemas).map(([k,v])=>[k,()=>structuredClone(v)]));
