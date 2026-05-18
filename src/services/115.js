// 115.js — barrel re-export. 实际实现拆分在 ./115/ 子目录下。
// 拆分后的模块：
//   client.js  fetch115Api / 重试 / 限流常量 / Cookie 读取
//   auth.js    扫码登录、Cookie 校验
//   files.js   listFolder / move / rename / recycle / createFolder / ensureFolderPath
//   tree.js    FolderTreeCache + 批量递归扫描
//   offline.js 离线下载
//   share.js   分享转存

export {
  fetch115Api,
  getActiveCookie,
  getOpDelayMs,
  pickField,
  sleep,
  UA_APPLE_TV,
  UA_CHROME,
  WRITE_OP_DELAY_MS,
  DELETE_OP_DELAY_MS,
} from './115/client.js';

export {
  fetchQrToken,
  fetchQrStatus,
  fetchQrLoginResult,
  fetch115UserInfo,
  saveCookie,
  verifyCookie,
  expireCookie,
} from './115/auth.js';

export {
  normalizeItem,
  listFolder,
  listFolders,
  listFiles,
  getFileInfo,
  renameFiles,
  renameFile,
  moveFiles,
  moveFile,
  createFolder,
  moveToRecycleBatch,
  moveToRecycle,
  deleteFile,
  deleteFolder,
  getDownloadUrl,
  searchFiles,
  getFolderPath,
  sanitizeSegment,
  findFolderByName,
  ensureFolderPath,
  getFolderInfo,
} from './115/files.js';

export {
  FolderTreeCache,
  listAllSubFolders,
  listAllSubFiles,
  listFilesRecursive,
  listFilesRecursiveFast,
} from './115/tree.js';

export { addOfflineUrls } from './115/offline.js';
export { parseShareLink, fetchShareSnap, transferShareLink } from './115/share.js';
