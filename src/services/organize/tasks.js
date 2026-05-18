import { getDb } from '../db.js';
import { logger } from '../logger.js';
import { groupLabel } from './util.js';

/**
 * 把识别失败的组写入 unmatched_items 表，等待用户手动处理。
 * 同时记录 file_ids 列表，便于后续 resolveUnmatched 重建组结构。
 */
export async function pushUnmatched(group, id, reason) {
  const db = getDb();
  const fileIds = [...group.videos, ...group.metas].map(f => ({ id: f.id, name: f.name, size: f.size, isVideo: f._isVideo }));
  db.prepare(`INSERT INTO unmatched_items
    (source_path, source_name, media_type_guess, identify_attempts, fail_reason, status, file_ids, parent_cid)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      group.parentCid,
      groupLabel(group),
      id?.mediaType || 'unknown',
      JSON.stringify({ id, group: { kind: group.kind, folderName: group.folderName, videoCount: group.videos.length } }),
      reason,
      JSON.stringify(fileIds),
      group.parentCid,
    );
  logger.warn('Organizer', `加入识别失败队列: ${groupLabel(group)} - ${reason}`);
}

/**
 * 把一条入库结果写入 task_items（运行日志/详情表）。
 * 容错地兜底所有字段，避免 NOT NULL 约束爆错。
 */
export function recordTaskItem(taskId, row) {
  const db = getDb();
  db.prepare(`INSERT INTO task_items
    (task_id, media_type, source_path, target_path, original_name, new_name,
     tmdb_id, season, episode, episode_end, identify_source, overwritten, recycled,
     duration_ms, target_cid, file_id, file_size, error)
    VALUES (@task_id, @media_type, @source_path, @target_path, @original_name, @new_name,
            @tmdb_id, @season, @episode, @episode_end, @identify_source, @overwritten, @recycled,
            @duration_ms, @target_cid, @file_id, @file_size, @error)`).run({
      task_id: row.task_id ?? taskId,
      media_type: row.media_type ?? 'movie',
      source_path: row.source_path ?? '',
      target_path: row.target_path ?? '',
      original_name: row.original_name ?? '',
      new_name: row.new_name ?? '',
      tmdb_id: row.tmdb_id ?? null,
      season: row.season ?? null,
      episode: row.episode ?? null,
      episode_end: row.episode_end ?? null,
      identify_source: row.identify_source ?? '',
      overwritten: row.overwritten ?? 0,
      recycled: row.recycled ?? 0,
      duration_ms: row.duration_ms ?? null,
      target_cid: row.target_cid ?? null,
      file_id: row.file_id ?? null,
      file_size: row.file_size ?? null,
      error: row.error ?? '',
    });
}
