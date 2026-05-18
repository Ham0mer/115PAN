import { getDb } from '../db.js';
import { logger } from '../logger.js';
import {
  listFolder, renameFile, renameFiles, moveFile, moveFiles,
  createFolder, findFolderByName, moveToRecycle, moveToRecycleBatch,
} from '../115.js';
import { detectLanguage, joinList } from '../parser.js';
import { buildSubtitleSuffix, buildMultiVersionSuffix, sanitizeName } from '../template.js';
import { extOf } from './util.js';
import { resolveMultiVersion } from './version.js';

/**
 * 把单个视频（与其元数据）落位到目标目录，处理多版本与同名冲突。
 *
 * 流程：
 * 1) resolveMultiVersion 与媒体库已有版本对比；
 * 2) 目标目录内同名文件冲突：mode=2 跳过 / multi_version 加 v2 后缀 / 否则保大或保小；
 * 3) 预先计算所有元数据新名；
 * 4) 一次性批量 move（视频 + 全部元数据），失败回退逐个；
 * 5) 一次性批量 rename，同样回退；
 * 6) 写入 media_library 便于后续多版本比对；
 * 7) 返回 'placed' / 'skipped' / 'recycled'。
 */
export async function placeVideo({ video, mediaInfo, id, targetCid, showCid, baseName, cfg, metas, mediaType, season, episode }) {
  const db = getDb();
  const ext = extOf(video.name);

  // 多版本判定
  const versionDecision = await resolveMultiVersion({
    mediaType: mediaType === 'anime' ? 'anime' : mediaType,
    tmdbId: id.tmdbId,
    season,
    episode,
    incoming: { id: video.id, size: video.size, info: mediaInfo, name: video.name },
    cfg,
  });
  if (versionDecision.action === 'recycleIncoming') {
    try { await moveToRecycle(video.id); } catch (err) { logger.warn('Organizer', '回收新文件失败', err.message); }
    db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
      VALUES (?,?,?,?,?,?,?)`).run(video.name, video.id, video.size, versionDecision.winnerPath || '', versionDecision.winnerSize || 0, '', '多版本-体积/规格较低');
    return 'recycled';
  }
  if (versionDecision.action === 'recycleExisting') {
    const loserIds = versionDecision.losers.map(o => o.file_id).filter(Boolean);
    if (loserIds.length) {
      try { await moveToRecycleBatch(loserIds); }
      catch (err) { logger.warn('Organizer', '回收旧版本失败', err.message); }
    }
    for (const old of versionDecision.losers) {
      db.prepare(`INSERT INTO recycle_records (source_path, file_id, file_size, winner_path, winner_size, loser_to, reason)
        VALUES (?,?,?,?,?,?,?)`).run(old.file_path, old.file_id, old.file_size, video.name, video.size, '', '多版本-被新版本替换');
      db.prepare('DELETE FROM media_library WHERE id=?').run(old.id);
    }
  }

  // 同名冲突处理
  let placedName = baseName + '.' + ext;
  let multiSuffixN = 1;

  const targetExisting = await listFolder(targetCid, { onlyFolders: false }).catch(() => []);
  let conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);

  if (conflict) {
    if (cfg.conflict_mode === 2) {
      logger.info('Organizer', `同名跳过: ${placedName}`);
      return 'skipped';
    }
    if (cfg.multi_version) {
      while (conflict) {
        multiSuffixN++;
        const suffix = buildMultiVersionSuffix(multiSuffixN);
        placedName = sanitizeName(baseName + suffix) + '.' + ext;
        conflict = targetExisting.find(it => !it.isFolder && it.name === placedName);
      }
    } else {
      const winsBig = cfg.conflict_mode === 1;
      const incomingSize = video.size;
      const existingSize = conflict.size;
      const incomingWins = winsBig ? incomingSize > existingSize : incomingSize < existingSize;
      if (!incomingWins) {
        try { await moveToRecycle(video.id); } catch {}
        return 'recycled';
      }
      try { await moveToRecycle(conflict.id); } catch (err) { logger.warn('Organizer', '回收同名文件失败', err.message); }
    }
  }

  // 预先计算元数据新名
  const metaPlan = metas.map(m => {
    const mExt = extOf(m.name);
    let metaName;
    if (cfg.rename_enabled) {
      const lang = detectLanguage(m.name);
      const langSuffix = buildSubtitleSuffix(lang);
      const metaStem = baseName + (lang ? langSuffix : '');
      metaName = sanitizeName(metaStem) + '.' + mExt;
    } else {
      metaName = m.name;
    }
    return { id: m.id, name: m.name, newName: metaName };
  });

  // 一次性批量移动
  const moveIds = [video.id, ...metaPlan.map(m => m.id)];
  try {
    await moveFiles(moveIds, targetCid);
  } catch (err) {
    logger.warn('Organizer', `批量移动失败，回退逐个: ${err.message}`);
    try { await moveFile(video.id, targetCid); }
    catch (e) { logger.warn('Organizer', `视频移动失败: ${video.name}`, e.message); }
    for (const m of metaPlan) {
      try { await moveFile(m.id, targetCid); }
      catch (e) { logger.warn('Organizer', `元数据移动失败: ${m.name}`, e.message); }
    }
  }

  // 一次性批量重命名
  if (cfg.rename_enabled) {
    const renamePairs = [[video.id, placedName], ...metaPlan.map(m => [m.id, m.newName])];
    try {
      await renameFiles(renamePairs);
    } catch (err) {
      logger.warn('Organizer', `批量重命名失败，回退逐个: ${err.message}`);
      try { await renameFile(video.id, placedName); }
      catch (e) { logger.warn('Organizer', `视频重命名失败: ${video.name}`, e.message); }
      for (const m of metaPlan) {
        try { await renameFile(m.id, m.newName); }
        catch (e) { logger.warn('Organizer', `元数据重命名失败: ${m.name}`, e.message); }
      }
    }
  }

  // 写入 media_library 表
  try {
    db.prepare(`INSERT OR REPLACE INTO media_library
      (media_type, tmdb_id, season, episode, target_cid, show_cid, file_id, file_path, file_size,
       resolution, source, video_codec, audio_codec, dolby)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        mediaType === 'anime' ? 'anime' : mediaType,
        id.tmdbId,
        season,
        episode,
        targetCid,
        showCid ?? targetCid,
        video.id,
        placedName,
        video.size,
        mediaInfo.resolution || null,
        joinList(mediaInfo.source) || null,
        mediaInfo.videoCodec || null,
        joinList(mediaInfo.audioCodec) || null,
        /truehd|atmos|dolby/i.test(joinList(mediaInfo.audioCodec)) ? 1 : 0,
      );
  } catch (err) {
    logger.debug('Organizer', `media_library 写入失败: ${err.message}`);
  }

  const seLabel = (season != null && episode != null) ? ` S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}` : '';
  logger.info('Organizer', `已入库${seLabel}: ${placedName} → cid=${targetCid}`);
  return 'placed';
}

/**
 * 取或建子目录。优先用 cache 命中；命中后直接返回，未命中才走 createFolder 并同步入 cache。
 */
export async function getOrCreateChildFolder(parentCid, name, cache = null) {
  const existing = await findFolderByName(parentCid, name, cache);
  if (existing) return existing;
  const created = await createFolder(parentCid, name);
  if (cache) cache.add(parentCid, name, created.cid);
  return created.cid;
}

/**
 * 通过 tmdbId 找已有的电影/剧目录。两阶段查找：
 * 1) media_library 命中；
 * 2) 在分类目录下扫描子目录名包含 "tmdb-{tmdbId}" 的。
 */
export async function findExistingShowCid(tmdbId, mediaType, catCid, cache = null) {
  const db = getDb();
  const types = mediaType === 'anime' ? ['anime', 'tv'] : [mediaType];
  for (const t of types) {
    const row = db.prepare(
      `SELECT show_cid FROM media_library WHERE media_type=? AND tmdb_id=? AND show_cid IS NOT NULL LIMIT 1`
    ).get(t, tmdbId);
    if (row?.show_cid) {
      logger.debug('Organizer', `DB命中已有文件夹 tmdb=${tmdbId} cid=${row.show_cid}`);
      return row.show_cid;
    }
  }

  const marker = `tmdb-${tmdbId}`;
  if (cache) {
    const catNode = cache.byId.get(String(catCid));
    if (catNode) {
      for (const [name, cid] of catNode.children) {
        if (name.includes(marker)) {
          logger.debug('Organizer', `缓存命中已有文件夹 tmdb=${tmdbId} name="${name}" cid=${cid}`);
          return cid;
        }
      }
      return null;
    }
  }
  try {
    const folders = await listFolder(catCid, { onlyFolders: true });
    const hit = folders.find(f => f.name.includes(marker));
    if (hit) {
      logger.debug('Organizer', `115扫描命中已有文件夹 tmdb=${tmdbId} name="${hit.name}" cid=${hit.id}`);
      return hit.id;
    }
  } catch (err) {
    logger.debug('Organizer', `115文件夹扫描失败 tmdb=${tmdbId}: ${err.message}`);
  }

  return null;
}
