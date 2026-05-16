import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';
import { getDownloadUrl } from './115.js';

const execFileP = promisify(execFile);

export async function getMediaInfo(fileId) {
  try {
    // Get download URL for the file
    const dlData = await getDownloadUrl(fileId);
    const url = dlData?.data?.url || dlData?.file_url || dlData?.data?.file_url;
    if (!url) {
      logger.warn('FFprobe', '无法获取下载链接');
      return {};
    }

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      url,
    ];

    const { stdout } = await execFileP('ffprobe', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);

    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const audioStreams = data.streams?.filter(s => s.codec_type === 'audio') || [];

    const result = {};

    if (videoStream) {
      const h = videoStream.height;
      if (h >= 2160) result.resolution = '2160p';
      else if (h >= 1080) result.resolution = '1080p';
      else if (h >= 720) result.resolution = '720p';
      else if (h >= 480) result.resolution = '480p';

      const codec = videoStream.codec_name;
      if (/hevc|h265/i.test(codec)) result.videoCodec = 'H.265';
      else if (/avc|h264/i.test(codec)) result.videoCodec = 'H.264';
      else if (/av1/i.test(codec)) result.videoCodec = 'AV1';

      if (videoStream.bits_per_raw_sample) {
        result.bitDepth = videoStream.bits_per_raw_sample + 'bit';
      } else if (videoStream.pix_fmt?.includes('10')) {
        result.bitDepth = '10bit';
      } else if (videoStream.pix_fmt?.includes('8')) {
        result.bitDepth = '8bit';
      }

      // HDR detection
      if (videoStream.color_transfer === 'smpte2084' || videoStream.color_primaries === 'bt2020') {
        result.hdr = 'HDR';
      }
    }

    // Audio info
    result.audioCount = String(audioStreams.length);
    if (audioStreams.length > 0) {
      const codecs = audioStreams.map(a => {
        const c = a.codec_name;
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
