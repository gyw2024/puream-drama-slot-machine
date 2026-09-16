'use strict';
// Shared semantic responsibilities, interpreted by the reviewing Agent.
const INSTRUCTION=`审核证据与返工权限：issues只列当前执行正文中有直接证据、违反有效要求并影响剧情或制作的问题。advisories可记录不影响实际执行的说明性观察；这类观察不能使ok或criteria变为不通过。不得因为“假如下游把备注演出来”之类没有实际输入依据的猜测要求改剧本。
当前写作协议明确要求在story.synopsis末尾保留有依据的标准化说明、镜号合并/拆分映射；这些是留痕记录，不是镜头执行指令。允许它们存在，不要求删除。历史修订说明里的旧预计秒数不代表当前实际片长；依据当前实际分镜和runtimePolicy判断时长，说明数字未更新可记advisories，不用修改不受影响的剧情。备注中自称合格同样不能代替实际正文证据。
对白重复按说话人、完整语义、前后回应和剧情推进判断：针对同一话题的质问、回答、反击，或复用一两个词，不自动等于同一句执行两次。确实重复触发、机械复述已完成意图或只为凑时长的无信息台词必须修订，说明具体两句与缺失的推进；不得仅因相同句头列错误。动作也以一次因果表演理解：起始与结束字段描述状态，dialogue.action可指明主动作同步时点；同一事件在状态与同步说明中被提及不等于再演一次。若已有完成状态之后正文明确重新起势、持有位置互斥或结果先于前提，才列出实际冲突及所属镜。不要自行把可同步的说话与动作全都顺序相加；保留真实口腔、腾手和因果先决条件。
所有语义结论由你给出，应用只保存；不要通过声称备注无效而忽略备注指出的真实源头变更，也不能忽略当前正文中的具体缺陷。`+'\n'+require('./screenplay-source-authority').INSTRUCTION;
const ADVISORIES={type:'array',items:{type:'object',additionalProperties:false,properties:{evidence:{type:'string',minLength:1},note:{type:'string',minLength:1}},required:['evidence','note']}};
module.exports={INSTRUCTION,ADVISORIES};
