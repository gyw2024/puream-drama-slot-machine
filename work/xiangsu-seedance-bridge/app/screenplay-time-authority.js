'use strict';
// Agent-facing capability facts. This module makes no content verdict.
const VERSION='story-time-versus-playback-v1';
const INSTRUCTION=`故事经过时间与视频播放时间必须分开：10–15秒限制的是最终视频播放长度，不是故事世界最多能经过多久。海螺多镜头提示词用[Shot 1]及后续带切点的[Shot N]描述同一条视频内部的切镜；一个制作片段不等于必须一镜到底。来源：https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md 第5.1节。
若当前剧本明确在完整对白/关键动作结束之后、结果反馈之前写出了时间省略的地点、经过多久和前后状态，允许导演在同一制作片段内部用有动机的切镜表达该省略，不必为省略另加一个10秒空等片段，也不能把故事省略的五分钟当作视频必须实际播放五分钟。没有用户或实际模式明确限制时，审核不得自行发明“单片段内不能跳切”或“时间省略只能放在镜间”的规则。
省略不等于随意跳过因果：源稿没有给出省略、把结果放在前提之前、明确要求连续拍摄完整等待过程、跳过关键接触/交接，仍需由Agent修正源头。不得自行用挂钟变化推导原稿未写出的时间，也不得仅凭备注自称合格批准正文矛盾。所有实际呈现的动作和完整对白仍须在10–15秒内清楚可演；镜内和跨镜真实播放中的无人声间隔仍不得超过3秒，切点不能截断原句。导演将源头省略写成清楚的前后画面与实际切点，禁止字幕标注时间，不把省略时长写成播放秒数；提示词审核核对实际表达，成片效果另需真实媒体验收。`;
module.exports={VERSION,INSTRUCTION};
