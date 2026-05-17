import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';
import { getDownloadUrl } from './115.js';

// 将回调式的 execFile 包装成 Promise 风格，便于 await 调用
const execFileP = promisify(execFile);

/**
 * 从 115 文件 ID 提取媒体技术信息（分辨率/编码/位深/HDR/音轨）。
 *
 * 流程：
 * 1) 调用 115 接口拿到该文件的 CDN 直链 URL；
 * 2) 用 ffprobe 直接读取 URL（无需下载到本地）；
 * 3) 解析 JSON，按规则映射为业务字段。
 *
 * 注意：依赖系统已安装 ffprobe 二进制；默认关闭，需配置 ffprobe_enabled。
 * 任何异常都不会向外抛出，最坏情况下返回空对象，避免阻塞主整理流程。
 *
 * @param {string|number} fileId 115 文件 ID
 * @returns {Promise<Object>} 包含 resolution/videoCodec/bitDepth/hdr/audioCodec/audioCount 的部分字段对象
 */
export async function getMediaInfo(fileId) {
  try {
    // 拿到 CDN 直链
    const dlData = await getDownloadUrl(fileId);
    const url = dlData?.data?.url || dlData?.file_url || dlData?.data?.file_url;
    if (!url) {
      logger.warn('FFprobe', '无法获取下载链接');
      return {};
    }

    // ffprobe 参数：静默 + JSON 输出 + 元数据 + 所有流信息
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      url,
    ];

    const { stdout } = await execFileP('ffprobe', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);

    // 通常只有一条视频流；音频流可能多条（多语言）
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const audioStreams = data.streams?.filter(s => s.codec_type === 'audio') || [];

    const result = {};

    if (videoStream) {
      // 分辨率：按高度向下取标准档位
      const h = videoStream.height;
      if (h >= 2160) result.resolution = '2160p';
      else if (h >= 1080) result.resolution = '1080p';
      else if (h >= 720) result.resolution = '720p';
      else if (h >= 480) result.resolution = '480p';

      // 视频编码名归一化（H.264 / H.265 / AV1）
      const codec = videoStream.codec_name;
      if (/hevc|h265/i.test(codec)) result.videoCodec = 'H.265';
      else if (/avc|h264/i.test(codec)) result.videoCodec = 'H.264';
      else if (/av1/i.test(codec)) result.videoCodec = 'AV1';

      // 位深：优先用 bits_per_raw_sample；否则从像素格式（如 yuv420p10le）推断
      if (videoStream.bits_per_raw_sample) {
        result.bitDepth = videoStream.bits_per_raw_sample + 'bit';
      } else if (videoStream.pix_fmt?.includes('10')) {
        result.bitDepth = '10bit';
      } else if (videoStream.pix_fmt?.includes('8')) {
        result.bitDepth = '8bit';
      }

      // HDR 探测：PQ(SMPTE2084) 传递函数 或 BT.2020 原色 即视为 HDR
      if (videoStream.color_transfer === 'smpte2084' || videoStream.color_primaries === 'bt2020') {
        result.hdr = 'HDR';
      }
    }

    // 音频信息：声轨数（字符串，便于模板拼接）+ 编码列表（去重后用 / 连接）
    result.audioCount = String(audioStreams.length);
    if (audioStreams.length > 0) {
      const codecs = audioStreams.map(a => {
        const c = a.codec_name;
        // 常见编码归一化为短名，缺失则直接大写
        if (/truehd/i.test(c)) return 'TrueHD';
        if (/eac3|e-ac3/i.test(c)) return 'DDP';
        if (/ac3/i.test(c)) return 'AC3';
        if (/aac/i.test(c)) return 'AAC';
        if (/dts/i.test(c)) return 'DTS';
        if (/flac/i.test(c)) return 'FLAC';
        return c?.toUpperCase();
      });
      result.audioCodec = [...new Set(codecs)].join('/');
    }

    return result;
  } catch (err) {
    logger.warn('FFprobe', '媒体信息提取失败', err.message);
    return {};
  }
}

/**
 * 从视频 CDN 直链中截取一帧作为缩略图（用于前端展示）。
 *
 * @param {string|number} fileId 115 文件 ID
 * @param {string} outputPath 输出图片路径（本地路径）
 * @returns {Promise<boolean>} 成功 true，失败 false（不抛出）
 *
 * ffmpeg 参数说明：
 * - `-ss 8`：跳到第 8 秒（避免片头黑屏/Logo）
 * - `-vframes 1`：只取 1 帧
 * - 缩放为 320x180，保持原宽高比
 * - `-q:v 8`：质量等级（数值越小越好，8 是兼顾体积的合理档位）
 * - `-y`：覆盖已存在的输出文件
 */
export async function generateThumbnail(fileId, outputPath) {
  try {
    const dlData = await getDownloadUrl(fileId);
    const url = dlData?.data?.url || dlData?.file_url || dlData?.data?.file_url;
    if (!url) throw new Error('无法获取下载链接');

    const args = [
      '-ss', '8',
      '-i', url,
      '-vframes', '1',
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease',
      '-q:v', '8',
      '-y',
      outputPath,
    ];

    await execFileP('ffmpeg', args, { timeout: 30000 });
    return true;
  } catch (err) {
    logger.warn('FFprobe', '缩略图生成失败', err.message);
    return false;
  }
}
