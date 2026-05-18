import { getDb } from '../db.js';
import { resolutionScore, isRemuxLike, hasDolby } from './mediainfo.js';

/**
 * 多版本决策器。
 * 在 media_library 中查找同 (mediaType, tmdbId, season, episode) 已有记录：
 * - conflict_mode=2 → 不处理；
 * - cfg.multi_version=true → 不处理，依靠命名后缀；
 * - 否则单版本模式：用 pickVersionWinner 决定回收新文件还是回收旧版本。
 *
 * action 取值：'none' / 'recycleIncoming' / 'recycleExisting'
 */
export async function resolveMultiVersion({ mediaType, tmdbId, season, episode, incoming, cfg }) {
  if (cfg.conflict_mode === 2) return { action: 'none' };
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM media_library WHERE media_type=? AND tmdb_id=? AND season IS ? AND episode IS ?`
  ).all(mediaType, tmdbId, season, episode);

  if (!existing.length) return { action: 'none' };

  if (cfg.multi_version) return { action: 'none' };

  const inc = incoming.info || {};
  const losers = [];
  let incomingWins = true;
  for (const ex of existing) {
    const exInfo = {
      source: ex.source,
      resolution: ex.resolution,
      videoCodec: ex.video_codec,
      audioCodec: ex.audio_codec,
    };
    const winner = pickVersionWinner(inc, exInfo, cfg, incoming.size, ex.file_size);
    if (winner === 'incoming') losers.push(ex);
    else if (winner === 'existing') incomingWins = false;
    else incomingWins = false;
  }
  if (!incomingWins) {
    const top = existing[0];
    return {
      action: 'recycleIncoming',
      winnerPath: top.file_path,
      winnerSize: top.file_size,
    };
  }
  if (losers.length) return { action: 'recycleExisting', losers };
  return { action: 'none' };
}

/**
 * 两个版本一一对比胜负，按优先级链：
 * 1) remux_priority；2) resolution_priority；3) dolby_priority；4) 体积兜底；5) 完全相同 → 'tie'。
 */
export function pickVersionWinner(a, b, cfg, aSize, bSize) {
  if (cfg.remux_priority) {
    const ra = isRemuxLike(a), rb = isRemuxLike(b);
    if (ra !== rb) return ra ? 'incoming' : 'existing';
  }
  if (cfg.resolution_priority) {
    const ra = resolutionScore(a.resolution), rb = resolutionScore(b.resolution);
    if (ra !== rb) return ra > rb ? 'incoming' : 'existing';
  }
  if (cfg.dolby_priority) {
    const da = hasDolby(a), db_ = hasDolby(b);
    if (da !== db_) return da ? 'incoming' : 'existing';
  }
  if (aSize !== bSize) {
    if (cfg.conflict_mode === 1) return aSize > bSize ? 'incoming' : 'existing';
    return aSize < bSize ? 'incoming' : 'existing';
  }
  return 'tie';
}
