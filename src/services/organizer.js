// organizer.js — barrel re-export. 实际实现拆分在 ./organize/ 子目录下。
// 拆分后的模块：
//   util.js      常量 / getConfig / 取消令牌 / extOf/stemOf / classifyTargetPath
//   group.js     filterFiles / groupFiles / matchMetasToEpisode
//   identify.js  identifyGroup / resolveViaTmdb（综合本地解析 + TMDB + AI）
//   mediainfo.js extractMediaInfo / mergeMediaInfo + 版本比较辅助
//   version.js   resolveMultiVersion / pickVersionWinner（多版本决策）
//   place.js     placeVideo / findExistingShowCid / getOrCreateChildFolder
//   tasks.js     pushUnmatched / recordTaskItem（DB 写入辅助）
//   process.js   processGroup / processMovieGroup / processTVGroup
//   cleanup.js   cleanupEmptyFolders（快/慢双路径）
//   run.js       runOrganize / rerunInPlace / resolveUnmatched（任务入口）

export { runOrganize, rerunInPlace, resolveUnmatched } from './organize/run.js';
export { requestCancel } from './organize/util.js';
