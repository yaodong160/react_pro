import { Socket, io } from 'socket.io-client';
import { localStg } from '@/utils/storage';
import { globalConfig } from '@/config';

export interface H264PlayerOptions {
  projectId: number;
  onError?: (msg: string) => void;
  onStatusChange?: (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;
}

/** 根据 SPS 数据生成正确的 codec 字符串 */
function buildCodecString(sps: Uint8Array): string {
  if (sps.length < 4) {
    return 'avc1.42E01E';
  }
  const profile = sps[1]; // profile_idc
  const compat = sps[2]; // profile_compatibility
  const level = sps[3];  // level_idc
  const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  const codec = `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
  return codec;
}

export class H264Player {
  private socket: Socket | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private blobUrl: string | null = null;
  private options: H264PlayerOptions;
  private pendingChunks: ArrayBuffer[] = [];
  private segmentBuffer: Uint8Array[] = [];
  private segmentBufferSize = 0;
  private attached = false;
  private socketReady = false;
  private streamStarted = false;
  private initReady = false;
  private initSegment: ArrayBuffer | null = null;
  private codecString: string | null = null;
  private fragmentCount = 0;
  private _firstVideoDataReceived: boolean | undefined = undefined;
  private _videoDataCount = 0;
  /** 后台查询返回的摄像头配置，用于构建正确的 init segment */
  private remoteConfig: { width: number; height: number; codec: string; spsBase64?: string; ppsBase64?: string } | null = null;
  private remoteConfigReady = false;
  private _configTimeout: ReturnType<typeof setTimeout> | null = null;
  private _resetting = false; // 防止重复触发 fullResetMediaSource

  constructor(options: H264PlayerOptions) {
    this.options = options;
  }

  attach(video: HTMLVideoElement) {
    if (this.attached) {
      return;
    }
    this.attached = true;

    this.videoElement = video;

    video.addEventListener('error', () => {
      const err = video.error;
      console.error('[H264Player] video error - code:', err?.code, 'message:', err?.message, 'MEDIA_ERR_ABORTED:', MediaError?.MEDIA_ERR_ABORTED, 'MEDIA_ERR_NETWORK:', MediaError?.MEDIA_ERR_NETWORK, 'MEDIA_ERR_DECODE:', MediaError?.MEDIA_ERR_DECODE, 'MEDIA_ERR_SRC_NOT_SUPPORTED:', MediaError?.MEDIA_ERR_SRC_NOT_SUPPORTED);
    });

    video.addEventListener('emptied', () => {
      console.log('[H264Player] video emptied (src changed/reset)');
    });

    video.addEventListener('loadedmetadata', () => {
      console.log('[H264Player] video loadedmetadata, duration:', video.duration, 'videoWidth:', video.videoWidth, 'videoHeight:', video.videoHeight);
    });

    video.addEventListener('canplay', () => {
      console.log('[H264Player] video canplay, currentTime:', video.currentTime);
    });

    video.addEventListener('playing', () => {
      console.log('[H264Player] video playing, currentTime:', video.currentTime);
    });

    video.addEventListener('waiting', () => {
      console.log('[H264Player] video waiting (buffering)');
    });

    this.connectSocket();

    this.mediaSource = new MediaSource();
    this.blobUrl = URL.createObjectURL(this.mediaSource);
    video.src = this.blobUrl;

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.attached || !this.mediaSource || this.mediaSource.readyState !== 'open') {
        return;
      }
      // 优先使用远程配置初始化
      if (this.remoteConfig && !this.initReady) {
        this.initFromRemoteConfig();
        return;
      }
      // 如果本地 init segment 已经就绪（在 sourceopen 之前就已收到），立即初始化
      if (this.initReady && this.initSegment && this.codecString) {
        this.initSourceBuffer();
      }
    });

    this.mediaSource.addEventListener('sourceended', () => {
      console.warn('[H264Player] MediaSource sourceended');
    });

    this.mediaSource.addEventListener('sourceclose', () => {
      console.warn('[H264Player] MediaSource sourceclose');
    });
  }

  /** 用解析出的 SPS 对应的 codec 创建 SourceBuffer 并 append init segment */
  private initSourceBuffer(): boolean {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open' || !this.codecString) {
      return false;
    }
    if (this.sourceBuffer) {
      // 旧 SourceBuffer 还在（正在被移除），返回 false 让调用方知道需要重试
      console.log('[H264Player] initSourceBuffer: 旧 SourceBuffer 仍存在，等待移除后重试');
      return false;
    }

    try {
      const mime = `video/mp4; codecs="${this.codecString}"`;
      console.log('[H264Player] 尝试初始化 SourceBuffer, MIME:', mime, 'isSupported:', MediaSource.isTypeSupported(mime));
      if (!MediaSource.isTypeSupported(mime)) {
        console.error('[H264Player] 浏览器不支持 codec:', mime);
        this.options.onError?.(`浏览器不支持编码 ${this.codecString}`);
        return false;
      }
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.mode = 'sequence';
      console.log('[H264Player] SourceBuffer 创建成功, mode:', this.sourceBuffer.mode);

      this.sourceBuffer.addEventListener('updateend', () => {
        this.flushPendingChunks();
      });

      this.sourceBuffer.addEventListener('error', (e) => {
        console.error('[H264Player] SourceBuffer error:', e);
        // 不调用 endOfStream，避免过早关闭 MediaSource
        // 错误可能只是暂时的，后续数据可能仍然可以 append
        if (this.mediaSource && this.mediaSource.readyState === 'open' && this.sourceBuffer) {
          try {
            this.sourceBuffer.abort();
          } catch { /* noop */ }
        }
      });

      if (this.initSegment) {
        this.sourceBuffer.appendBuffer(this.initSegment);
      }
      return true;
    } catch (e) {
      this.options.onError?.(`MSE 初始化失败: ${e}`);
      return false;
    }
  }

  /**
   * 使用后台返回的远程配置（分辨率+codec）构建 init segment 并初始化 SourceBuffer
   * 优先于本地 SPS 解析
   */
  private initFromRemoteConfig() {
    if (!this.remoteConfig || !this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }
    const { width, height, codec, spsBase64, ppsBase64 } = this.remoteConfig;
    console.log('[H264Player] 使用远程配置初始化: codec:', codec, '分辨率:', width, 'x', height);

    this.codecString = codec;

    let avcC: Uint8Array;
    if (spsBase64 && ppsBase64) {
      try {
        const sps = Uint8Array.from(atob(spsBase64), c => c.charCodeAt(0));
        const pps = Uint8Array.from(atob(ppsBase64), c => c.charCodeAt(0));
        avcC = buildAvcC(sps, pps);
      } catch {
        // base64 解码失败，用 SPS profile/level 构建最小 avcC
        console.warn('[H264Player] sps/pps base64 解码失败，使用 codec 字符串构建 avcC');
        avcC = buildAvcCFromCodecString(codec);
      }
    } else {
      avcC = buildAvcCFromCodecString(codec);
    }

    const init = buildInitManual(avcC, width, height);
    this.initSegment = init.buffer as ArrayBuffer;
    const ok = this.initSourceBuffer();
    if (ok) {
      this.initReady = true;
    }
  }

  /** 
   * 配置变更时：只移除旧 SourceBuffer，不立即重建
   * 让后续的 video_data(ftyp+moov) 通过 handleFirstSegment 完成初始化
   */
  private removeOldSourceBuffer() {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }
    if (!this.sourceBuffer) {
      return;
    }
    try {
      const oldSb = this.sourceBuffer;
      if (oldSb.updating) {
        const onUpdateEnd = () => {
          oldSb.removeEventListener('updateend', onUpdateEnd);
          this.doRemoveOldSb();
        };
        oldSb.addEventListener('updateend', onUpdateEnd);
        return;
      }
      this.doRemoveOldSb();
    } catch {
      this.doRemoveOldSb();
    }
  }

  private doRemoveOldSb() {
    if (!this.mediaSource || !this.sourceBuffer) {
      return;
    }
    try {
      try { this.sourceBuffer.abort(); } catch { /* noop */ }
      if (this.sourceBuffer.buffered.length > 0) {
        const start = this.sourceBuffer.buffered.start(0);
        const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
        this.sourceBuffer.remove(start, end);
      }
    } catch { /* noop */ }

    try {
      const doRemove = () => {
        if (this.mediaSource && this.sourceBuffer) {
          try {
            this.mediaSource.removeSourceBuffer(this.sourceBuffer);
          } catch { /* noop */ }
          this.sourceBuffer = null;
          // 不调用 initFromRemoteConfig，等待 video_data(ftyp+moov) 来初始化
          console.log('[H264Player] 旧 SourceBuffer 已移除，等待后台推送新的 init segment');
        }
      };

      if (this.sourceBuffer?.updating) {
        const onUpdateEnd = () => {
          this.sourceBuffer?.removeEventListener('updateend', onUpdateEnd);
          doRemove();
        };
        this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
      } else {
        doRemove();
      }
    } catch {
      this.sourceBuffer = null;
    }
  }

  /**
   * 完全重置 MediaSource：关闭旧 MediaSource 并创建新的
   * 用于 config_changed 场景或 decode error 恢复，彻底清除 video element 的 error 状态
   * 内置防抖：正在重置中时跳过重复调用
   */
  private fullResetMediaSource() {
    if (this._resetting) {
      console.log('[H264Player] fullResetMediaSource: 已在重置中，跳过重复调用');
      return;
    }
    this._resetting = true;
    console.log('[H264Player] fullResetMediaSource: 开始完全重置');

    // 1. 清理旧 SourceBuffer
    if (this.sourceBuffer) {
      try { this.sourceBuffer.abort(); } catch { /* noop */ }
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        } catch { /* noop */ }
      }
      this.sourceBuffer = null;
    }

    // 2. 先保存旧 MS 和旧 blob URL 引用，再置空，防止事件回调中重复处理
    const oldMs = this.mediaSource;
    const oldBlobUrl = this.blobUrl;
    this.mediaSource = null;
    this.blobUrl = null;

    // 3. 重置状态
    this.initReady = false;
    this.initSegment = null;
    this.codecString = null;
    this.pendingChunks = [];
    this.segmentBuffer = [];
    this.segmentBufferSize = 0;
    this.fragmentCount = 0;

    // 4. 创建新的 MediaSource 和 blob URL
    this.mediaSource = new MediaSource();
    this.blobUrl = URL.createObjectURL(this.mediaSource);

    // 5. 设置 sourceopen 监听
    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.attached || !this.mediaSource || this.mediaSource.readyState !== 'open') {
        return;
      }
      console.log('[H264Player] fullResetMediaSource: sourceopen，使用 remoteConfig 直接初始化');
      if (this.remoteConfig) {
        this.initFromRemoteConfig();
      }
    });

    this.mediaSource.addEventListener('sourceended', () => {
      console.warn('[H264Player] MediaSource sourceended (after reset)');
    });
    this.mediaSource.addEventListener('sourceclose', () => {
      console.warn('[H264Player] MediaSource sourceclose (after reset)');
    });

    // 6. 更新 video.src 触发 sourceopen（这也会触发旧 MS 的 sourceclose）
    if (this.videoElement) {
      console.log('[H264Player] fullResetMediaSource: 更新 video.src');
      this.videoElement.src = this.blobUrl;
    }

    // 7. 异步关闭旧 MS 和释放旧 blob URL
    if (oldMs && oldMs.readyState !== 'closed') {
      setTimeout(() => {
        try {
          if (oldMs.readyState === 'open') {
            oldMs.endOfStream();
          }
        } catch { /* noop */ }
        if (oldBlobUrl) {
          URL.revokeObjectURL(oldBlobUrl);
        }
      }, 100);
    } else if (oldBlobUrl) {
      setTimeout(() => {
        URL.revokeObjectURL(oldBlobUrl);
      }, 100);
    }

    // 8. 延迟清除 _resetting 标志，给 sourceopen 足够时间触发
    setTimeout(() => {
      this._resetting = false;
      console.log('[H264Player] fullResetMediaSource: _resetting 标志已清除');
    }, 2000);

    console.log('[H264Player] fullResetMediaSource: 完成，等待 sourceopen 事件');
  }

  /** 配置变更时重建 SourceBuffer（使用新的分辨率/codec） */
  private rebuildSourceBuffer() {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }
    // 移除旧的 SourceBuffer
    if (this.sourceBuffer) {
      try {
        const oldSb = this.sourceBuffer;
        // 如果正在 updating，等 updateend 后再 remove
        if (oldSb.updating) {
          const onUpdateEnd = () => {
            oldSb.removeEventListener('updateend', onUpdateEnd);
            this.doRemoveAndRebuild();
          };
          oldSb.addEventListener('updateend', onUpdateEnd);
          return;
        }
        this.doRemoveAndRebuild();
      } catch {
        this.doRemoveAndRebuild();
      }
    } else {
      this.initFromRemoteConfig();
    }
  }

  private doRemoveAndRebuild() {
    if (!this.mediaSource || !this.sourceBuffer) {
      return;
    }
    try {
      // 先 abort 中断当前操作（可能已处于错误状态）
      try { this.sourceBuffer.abort(); } catch { /* noop */ }
      // 清空 buffered 区域
      if (this.sourceBuffer.buffered.length > 0) {
        const start = this.sourceBuffer.buffered.start(0);
        const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
        this.sourceBuffer.remove(start, end);
      }
    } catch { /* noop */ }

    try {
      // 等待 remove 完成后移除 SourceBuffer
      const doRemoveSb = () => {
        if (this.mediaSource && this.sourceBuffer) {
          try {
            this.mediaSource.removeSourceBuffer(this.sourceBuffer);
          } catch { /* noop */ }
          this.sourceBuffer = null;
          // 用新配置初始化
          this.initFromRemoteConfig();
        }
      };

      if (this.sourceBuffer?.updating) {
        const onUpdateEnd = () => {
          this.sourceBuffer?.removeEventListener('updateend', onUpdateEnd);
          doRemoveSb();
        };
        this.sourceBuffer.addEventListener('updateend', onUpdateEnd);
      } else {
        doRemoveSb();
      }
    } catch {
      this.sourceBuffer = null;
      this.initFromRemoteConfig();
    }
  }

  private connectSocket() {
    const serverUrl = globalConfig.serviceBaseURL.replace(/\/api$/, '');
    const token = localStg.get('token') || '';
    const namespace = '/ws/camera';
    const socketPath = '/api/socket.io';

    this.socket = io(`${serverUrl}${namespace}`, {
      path: socketPath,
      transports: ['websocket', 'polling'],
      auth: { token },
      query: { token }
    });

    this.socket.on('connect', () => {
      console.log('[H264Player] Backend connected event: socket.io 连接成功');
      this.socketReady = true;
      this.tryStartStream();
    });

    this.socket.on('stream_info', (_info: any) => {
      console.log('[H264Player] stream_info:', JSON.stringify(_info));
      this.options.onStatusChange?.('connected');
    });

    // 接收后台返回的摄像头配置（后端自动推送，1-3秒内到达）
    this.socket.on('config_response', (config: {
      width: number;
      height: number;
      codec: string;
      sps?: string; // base64
      pps?: string;
    }) => {
      console.log('[H264Player] 收到 config_response:', JSON.stringify({ width: config.width, height: config.height, codec: config.codec, spsLen: config.sps?.length, ppsLen: config.pps?.length }));
      if (config.width > 0 && config.height > 0 && config.codec) {
        this.remoteConfig = {
          width: config.width,
          height: config.height,
          codec: config.codec,
          spsBase64: config.sps,
          ppsBase64: config.pps
        };
        this.remoteConfigReady = true;
        if (this._configTimeout) {
          clearTimeout(this._configTimeout);
          this._configTimeout = null;
        }
        // 如果还没初始化，用远程配置初始化
        if (!this.initReady && this.mediaSource?.readyState === 'open') {
          this.initFromRemoteConfig();
        } else if (this.initReady) {
          console.log('[H264Player] config_response 到达时已初始化，保留当前配置（若需切换请等待 config_changed）');
        }
      } else {
        console.warn('[H264Player] config_response 数据不完整，使用本地 SPS 解析兜底');
      }
    });

    // 接收后台推送的配置变更通知（用户修改了摄像头分辨率或 PTZ 导致后台重启推流）
    this.socket.on('config_changed', (config: {
      width: number;
      height: number;
      codec: string;
      sps?: string;
      pps?: string;
    }) => {
      console.log('[H264Player] 收到 config_changed（摄像头配置已变更）:', JSON.stringify(config));
      if (config.width > 0 && config.height > 0 && config.codec) {
        this.remoteConfig = {
          width: config.width,
          height: config.height,
          codec: config.codec,
          spsBase64: config.sps,
          ppsBase64: config.pps
        };
        this.remoteConfigReady = true;
        // 完全重置：重建 MediaSource 以清除 video element 的错误状态
        // 仅移除 SourceBuffer 不够，video element 可能已经进入 error 状态
        console.log('[H264Player] config_changed: 完全重置 MediaSource 以清除 video 错误状态');
        this.fullResetMediaSource();
      }
    });

    this.socket.on('video_data', (chunk: any) => {
      // 首个数据块打印详细信息
      if (this._firstVideoDataReceived === undefined) {
        this._firstVideoDataReceived = true;
        console.log('[H264Player] First video_data chunk received, type:', typeof chunk, 'isArrayBuffer:', chunk instanceof ArrayBuffer, 'isView:', ArrayBuffer.isView(chunk), 'byteLength:', (chunk as any)?.byteLength ?? (chunk as any)?.length ?? 'unknown');
      }

      let data: ArrayBuffer | null = null;
      if (chunk instanceof ArrayBuffer) {
        data = chunk;
      } else if (ArrayBuffer.isView(chunk)) {
        data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      } else {
        console.warn('[H264Player] video_data 类型异常:', typeof chunk, chunk);
        return;
      }

      this._videoDataCount++;
      this.segmentBuffer.push(new Uint8Array(data));
      this.segmentBufferSize += data.byteLength;
      this.tryExtractSegment();
    });

    this.socket.on('stream_end', (data: { reason?: string }) => {
      console.log('[H264Player] stream_end:', data?.reason || 'unknown');
      this.options.onStatusChange?.('disconnected');
    });

    this.socket.on('error', (data: { message?: string }) => {
      this.options.onError?.(data?.message || '未知错误');
    });

    this.socket.on('disconnect', (_reason) => {
      this.options.onStatusChange?.('disconnected');
    });

    this.socket.on('connect_error', (err) => {
      this.options.onError?.(`Socket.IO 连接失败: ${err?.message || ''}`);
    });
  }

  /**
   * 从 segmentBuffer 中尝试提取完整的 fMP4 segment
   * 后端可能将一个 segment 拆分成多个 chunk 发送，
   * 需要根据 moof+mdat 的声明大小来判断 segment 是否完整
   */
  private tryExtractSegment() {
    // 至少需要 8 字节来判断 segment 类型
    if (this.segmentBufferSize < 8) {
      return;
    }

    // 安全检查：segment buffer 过大（>5MB），说明解码器跟不上，丢弃旧数据
    if (this.segmentBufferSize > 5 * 1024 * 1024) {
      console.warn('[H264Player] segment buffer 过大 (' + (this.segmentBufferSize / 1024 / 1024).toFixed(1) + 'MB)，清空并跳过以保护解码器');
      this.clearSegmentBuffer();
      return;
    }

    // 重试：之前 handleFirstSegment 已解析出 codecString 和 initSegment，
    // 但 initSourceBuffer 因旧 SourceBuffer 未移除而失败，现在重试
    if (!this.initReady && this.codecString && this.initSegment && !this.sourceBuffer) {
      console.log('[H264Player] tryExtractSegment: 检测到待重试的初始化（codecString+initSegment 已就绪，sourceBuffer 已释放）');
      const ok = this.initSourceBuffer();
      if (ok) {
        this.initReady = true;
        // 当前 buffer 中的数据可能是 moof+mdat fragment，继续正常处理
      } else {
        // 仍然失败，继续等待
        return;
      }
    }

    // 将缓冲区拼接成连续数组
    const combined = new Uint8Array(this.segmentBufferSize);
    let offset = 0;
    for (const chunk of this.segmentBuffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // 检查 buffer 开头类型
    // ftyp, moov, moof, styp 都是可能的起始 box
    const boxType = String.fromCharCode(combined[4], combined[5], combined[6], combined[7]);
    const boxSize = (combined[0] << 24) | (combined[1] << 16) | (combined[2] << 8) | combined[3];

    // 诊断日志：打印缓冲区头部信息
    const firstBytes = Array.from(combined.slice(0, Math.min(16, combined.length))).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('[H264Player] tryExtractSegment: boxType:', boxType, 'boxSize:', boxSize, 'bufferSize:', this.segmentBufferSize, 'initReady:', this.initReady, 'firstBytes:', firstBytes);

    if (boxType === 'moof') {
      // 这是一个 fragment (moof + mdat)
      // 需要找到 moof 之后紧跟的 mdat 的 size
      if (boxSize < 8 || boxSize > this.segmentBufferSize) {
        return;
      } // moof 还没收完
      if (boxSize + 8 > this.segmentBufferSize) {
        return;
      } // mdat 的 size 字段还没到

      // mdat 在 moof 之后，其 size 在 moof 结束偏移处
      const mdatStart = boxSize;
      if (mdatStart + 4 > this.segmentBufferSize) {
        return;
      }
      const mdatSize = (combined[mdatStart] << 24) | (combined[mdatStart + 1] << 16) |
                       (combined[mdatStart + 2] << 8) | combined[mdatStart + 3];

      // 检查 mdat 标识
      if (mdatStart + 8 > this.segmentBufferSize) {
        return;
      }
      const mdatType = String.fromCharCode(
        combined[mdatStart + 4], combined[mdatStart + 5],
        combined[mdatStart + 6], combined[mdatStart + 7]
      );

      if (mdatType !== 'mdat') {
        // mdat 不是紧跟在 moof 之后，无法确定 segment 边界，直接使用全部缓冲区
        console.warn('[H264Player] moof 后不是 mdat, 类型:', mdatType, '清空缓冲区并尝试 append');
        const data = combined.buffer.slice(0, this.segmentBufferSize) as ArrayBuffer;
        this.clearSegmentBuffer();
        if (!this.initReady) {
          this.handleFirstSegment(data);
        } else {
          this.doAppend(data);
        }
        return;
      }

      const totalSegmentSize = boxSize + mdatSize;
      if (this.segmentBufferSize < totalSegmentSize) {
        return;
      }

      const segmentData = combined.buffer.slice(0, totalSegmentSize) as ArrayBuffer;

      // 从缓冲区移除已处理的数据
      if (this.segmentBufferSize > totalSegmentSize) {
        const remaining = combined.buffer.slice(totalSegmentSize) as ArrayBuffer;
        this.segmentBuffer = [new Uint8Array(remaining)];
        this.segmentBufferSize = remaining.byteLength;
      } else {
        this.clearSegmentBuffer();
      }

      if (!this.initReady) {
        // 后端未发送 ftyp+moov init segment，直接从 moof+mdat 中提取 SPS/PPS 构建 init
        console.log('[H264Player] 收到 moof+mdat 但 init 未就绪，从 fragment 中提取 SPS/PPS 构建 init, segmentData size:', segmentData.byteLength);
        this.buildInitFromFragment(segmentData);
        // 把 moof+mdat 缓存起来，等 init segment append 完成后再 append
        this.pendingChunks.push(segmentData);
      } else {
        this.doAppend(segmentData);
      }
    } else if (boxType === 'ftyp' || boxType === 'styp') {
      // init segment 或 segment type box
      // 对于 ftyp/styp，如果后面有 moov，需要一起处理
      const moovIdx = findBoxTypeIndex(combined, 8, 'moov');
      if (moovIdx >= 0) {
        // 有 moov，检查 moov 是否完整
        const moovSize = (combined[moovIdx] << 24) | (combined[moovIdx + 1] << 16) |
                         (combined[moovIdx + 2] << 8) | combined[moovIdx + 3];
        const totalNeeded = moovIdx + moovSize;
        if (this.segmentBufferSize >= totalNeeded) {
          // 完整 init segment
          const segmentData = combined.buffer.slice(0, totalNeeded) as ArrayBuffer;
          if (this.segmentBufferSize > totalNeeded) {
            const remaining = combined.buffer.slice(totalNeeded) as ArrayBuffer;
            this.segmentBuffer = [new Uint8Array(remaining)];
            this.segmentBufferSize = remaining.byteLength;
          } else {
            this.clearSegmentBuffer();
          }
          if (!this.initReady) {
            this.handleFirstSegment(segmentData);
          } else if (this.remoteConfigReady) {
            // initReady=true 且已有 remoteConfig → config_response 已提前初始化
            // 这是后台发送的正式 init segment（与 config_response 配对），跳过即可
            console.log('[H264Player] initReady=true 收到 ftyp+moov，但已通过 config_response 初始化，跳过（正常流程）');
            // 后续 moof+mdat fragment 会正常 append
          } else {
            // initReady 为 true 但没有 remoteConfig（本地 SPS 解析初始化的）
            // 收到 ftyp+moov → 后台可能重启了 ffmpeg，触发 SourceBuffer 重建
            console.warn('[H264Player] initReady=true 但收到 ftyp+moov（无 remoteConfig），后台可能重启了推流，触发 SourceBuffer 重建');
            // 缓存这个 init segment 用于重建
            this.initSegment = segmentData;
            this.initReady = false; // 标记为需要重新初始化
            this.codecString = null;
            this.rebuildSourceBuffer();
          }
        }
        // 否则继续等待
      } else {
        // 只有 ftyp/styp 没有 moov，直接使用（可能是小 segment）
        const segmentData = combined.buffer.slice(0, this.segmentBufferSize) as ArrayBuffer;
        this.clearSegmentBuffer();
        if (!this.initReady) {
          this.handleFirstSegment(segmentData);
        } else {
          this.doAppend(segmentData);
        }
      }
    } else if (boxType === 'moov') {
      // 后端可能从 moov 开始发送（无 ftyp）
      // moov box 可能很大，需要等数据收齐
      if (boxSize < 8 || boxSize > 10 * 1024 * 1024) {
        // boxSize 异常（0 或超过 10MB），清空
        console.warn('[H264Player] moov box size 异常:', boxSize, '清空缓冲区');
        this.clearSegmentBuffer();
        return;
      }
      if (this.segmentBufferSize < boxSize) {
        // moov 还没收完，继续等待
        return;
      }
      const segmentData = combined.buffer.slice(0, boxSize) as ArrayBuffer;
      if (this.segmentBufferSize > boxSize) {
        const remaining = combined.buffer.slice(boxSize) as ArrayBuffer;
        this.segmentBuffer = [new Uint8Array(remaining)];
        this.segmentBufferSize = remaining.byteLength;
      } else {
        this.clearSegmentBuffer();
      }
      console.log('[H264Player] moov box 完整, size:', boxSize);
      this.handleFirstSegment(segmentData);
    } else if (boxType === 'sidx') {
      // sidx (Segment Index Box): 合法的 fMP4 box，出现在 moov 之后、moof 之前
      // 浏览器 MSE 不需要 sidx，直接跳过
      if (boxSize < 8 || boxSize > 10 * 1024 * 1024) {
        console.warn('[H264Player] sidx box size 异常:', boxSize, '清空缓冲区');
        this.clearSegmentBuffer();
        return;
      }
      if (this.segmentBufferSize < boxSize) {
        // sidx 还没收完，继续等待
        return;
      }
      console.log('[H264Player] 跳过 sidx box, size:', boxSize);
      // 移除 sidx，保留后续数据
      if (this.segmentBufferSize > boxSize) {
        const remaining = combined.buffer.slice(boxSize) as ArrayBuffer;
        this.segmentBuffer = [new Uint8Array(remaining)];
        this.segmentBufferSize = remaining.byteLength;
        // 递归处理后续数据
        this.tryExtractSegment();
      } else {
        this.clearSegmentBuffer();
      }
    } else {
      console.warn('[H264Player] 未知 segment 类型:', boxType, '清空缓冲区');
      const data = combined.buffer.slice(0, this.segmentBufferSize) as ArrayBuffer;
      this.clearSegmentBuffer();
      if (!this.initReady) {
        this.handleFirstSegment(data);
      } else {
        this.doAppend(data);
      }
    }
  }

  private clearSegmentBuffer() {
    this.segmentBuffer = [];
    this.segmentBufferSize = 0;
  }

  private handleFirstSegment(data: ArrayBuffer) {
    const view = new Uint8Array(data);

    // 检查是否是 moov box（后端可能从 moov 开始，无 ftyp）
    if (view.byteLength >= 8 && view[4] === 0x6D && view[5] === 0x6F && view[6] === 0x6F && view[7] === 0x76) {
      // 直接从 moov 中提取 avcC
      const avcC = extractAvcCFromMoov(view);
      // 从原始 moov 的 tkhd/avc1 中提取分辨率（比 SPS bit-level 解析更可靠）
      const moovResolution = extractResolutionFromMoov(view);
      console.log('[H264Player] 从 moov 原始 box 提取分辨率:', moovResolution, 'moov size:', view.byteLength);
      if (avcC) {
        const sps = extractSpsFromAvcC(avcC);
        const pps = extractPpsFromAvcC(avcC);
        if (sps && pps) {
          this.codecString = buildCodecString(sps);
          // 使用从 moov 原始 box 中提取的分辨率，不依赖 buggy 的 SPS 解析
          const resolution = moovResolution || parseSpsResolution(sps);
          console.log('[H264Player] 从 moov 解析到 codec:', this.codecString, '分辨率:', resolution);
          const avcCBox = buildAvcC(sps, pps);
          const { width, height } = resolution;
          const init = buildInitManual(avcCBox, width, height);
          this.initSegment = init.buffer as ArrayBuffer;
        } else {
          this.codecString = 'avc1.42E01E';
          console.warn('[H264Player] 从 moov avcC 中未提取到 SPS/PPS，使用默认 codec，尝试用原始 moov 做 init');
          this.initSegment = data;
        }
      } else {
        // moov 中无 avcC，尝试从整个 data 中搜索 SPS/PPS（可能是 mdat 中的数据）
        console.warn('[H264Player] moov 中无 avcC box (moov size:', view.byteLength, ')，尝试从数据中搜索 SPS/PPS');
        const spsPps = extractSpsPpsOnly(data);
        if (spsPps) {
          const { sps, pps } = spsPps;
          this.codecString = buildCodecString(sps);
          const resolution = moovResolution || parseSpsResolution(sps);
          console.log('[H264Player] 从数据中搜索到 SPS/PPS, codec:', this.codecString, '分辨率:', resolution);
          const avcCBox = buildAvcC(sps, pps);
          const { width, height } = resolution;
          const init = buildInitManual(avcCBox, width, height);
          this.initSegment = init.buffer as ArrayBuffer;
        } else {
          this.codecString = 'avc1.42E01E';
          console.warn('[H264Player] 无法从数据中提取 SPS/PPS，使用默认 codec 和原始 moov');
          this.initSegment = data;
        }
      }
      const ok = this.initSourceBuffer();
      if (ok) {
        this.initReady = true;
      } else {
        // SourceBuffer 创建失败（旧 SB 还在移除中），保持 initReady=false
        // 保留 initSegment 和 codecString，等旧 SB 移除后重试
        console.log('[H264Player] moov 解析完成但 SourceBuffer 创建失败（旧 SB 未移除），等待重试');
        // 不设置 initReady=true，让后续 video_data 触发 tryExtractSegment 重试
        // 但 initSegment 和 codecString 已保存，下次 handleFirstSegment 会直接 initSourceBuffer
      }
      return;
    }

    // 检查是否是 init segment（以 ftyp 开头）
    if (view.byteLength >= 8 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
      const hasMoov = containsMoov(view);
      console.log('[H264Player] handleFirstSegment ftyp: hasMoov:', hasMoov, 'dataSize:', view.byteLength);
      if (hasMoov) {
        const avcC = extractAvcCFromMoov(view);
        console.log('[H264Player] handleFirstSegment ftyp+moov: avcC found:', !!avcC);
        if (avcC) {
          const sps = extractSpsFromAvcC(avcC);
          const pps = extractPpsFromAvcC(avcC);
          if (sps && pps) {
            this.codecString = buildCodecString(sps);
            this.initSegment = data;
            console.log('[H264Player] ftyp+moov 分支: codec:', this.codecString, 'initSegment size:', this.initSegment.byteLength);
          } else {
            this.codecString = 'avc1.42E01E';
            this.initSegment = data;
            console.warn('[H264Player] ftyp+moov 分支: SPS/PPS 提取失败，使用默认 codec');
          }
        } else {
          this.codecString = 'avc1.42E01E';
          this.initSegment = data;
          console.warn('[H264Player] ftyp+moov 分支: avcC 未找到，使用原始数据');
        }
        const ok = this.initSourceBuffer();
        if (ok) {
          this.initReady = true;
        } else {
          console.log('[H264Player] ftyp+moov 解析完成但 SourceBuffer 创建失败（旧 SB 未移除），等待重试');
        }
      } else {
        console.log('[H264Player] ftyp 但无 moov，放入 pendingChunks, dataSize:', view.byteLength);
        this.pendingChunks.push(data);
      }
      return;
    }

    // 如果 segment 太小（< 100 字节），可能只是 header/元数据，等下一个
    if (view.byteLength < 100) {
      return;
    }

    const result = extractSpsPpsOnly(data);
    if (result) {
      const { sps, pps } = result;
      this.codecString = buildCodecString(sps);
      const avcC = buildAvcC(sps, pps);
      // 尝试解析分辨率，失败或异常则用安全默认值
      let width = 1920;
      let height = 1080;
      try {
        const res = parseSpsResolution(sps);
        if (res.width >= 100 && res.width <= 10000 && res.height >= 100 && res.height <= 10000) {
          width = res.width;
          height = res.height;
        } else {
          console.warn('[H264Player] fallback parseSpsResolution 返回异常:', res, '使用默认值');
        }
      } catch {
        console.warn('[H264Player] fallback parseSpsResolution 抛异常，使用默认分辨率');
      }
      console.log('[H264Player] fallback 分支: codec:', this.codecString, '分辨率:', width, 'x', height);
      const init = buildInitManual(avcC, width, height);
      this.initSegment = init.buffer as ArrayBuffer;
      this.pendingChunks.push(data);
      const ok = this.initSourceBuffer();
      if (ok) {
        this.initReady = true;
      } else {
        console.log('[H264Player] fallback 解析完成但 SourceBuffer 创建失败（旧 SB 未移除），等待重试');
      }
    } else {
      this.pendingChunks.push(data);
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        this.flushPendingChunks();
      }
    }
  }

  /**
   * 从 moof+mdat fragment 中提取 SPS/PPS 构建 init segment
   * 用于后端不发送 ftyp+moov 的场景
   */
  private buildInitFromFragment(fragmentData: ArrayBuffer) {
    console.log('[H264Player] buildInitFromFragment: fragment size:', fragmentData.byteLength, 'remoteConfigReady:', this.remoteConfigReady);

    // 优先使用后台返回的远程配置
    if (this.remoteConfig) {
      console.log('[H264Player] buildInitFromFragment: 使用远程配置 (跳过本地SPS解析)');
      this.codecString = this.remoteConfig.codec;
      let avcC: Uint8Array;
      if (this.remoteConfig.spsBase64 && this.remoteConfig.ppsBase64) {
        try {
          const sps = Uint8Array.from(atob(this.remoteConfig.spsBase64), c => c.charCodeAt(0));
          const pps = Uint8Array.from(atob(this.remoteConfig.ppsBase64), c => c.charCodeAt(0));
          avcC = buildAvcC(sps, pps);
        } catch {
          avcC = buildAvcCFromCodecString(this.remoteConfig.codec);
        }
      } else {
        avcC = buildAvcCFromCodecString(this.remoteConfig.codec);
      }
      const init = buildInitManual(avcC, this.remoteConfig.width, this.remoteConfig.height);
      this.initSegment = init.buffer as ArrayBuffer;
      const ok = this.initSourceBuffer();
      if (ok) {
        this.initReady = true;
      } else {
        console.log('[H264Player] buildInitFromFragment remoteConfig: SourceBuffer 创建失败，等待重试');
      }
      return;
    }

    // 兜底：本地从 fragment 中提取 SPS/PPS
    const result = extractSpsPpsOnly(fragmentData);
    if (result) {
      const { sps, pps } = result;
      this.codecString = buildCodecString(sps);
      const avcC = buildAvcC(sps, pps);
      // 尝试解析分辨率，失败则用安全默认值
      let resolution = { width: 1920, height: 1080 };
      try {
        resolution = parseSpsResolution(sps);
        // 验证分辨率合理性
        if (resolution.width < 100 || resolution.width > 10000 || resolution.height < 100 || resolution.height > 10000) {
          console.warn('[H264Player] parseSpsResolution 返回异常分辨率:', resolution, '使用默认值');
          resolution = { width: 1920, height: 1080 };
        }
      } catch {
        console.warn('[H264Player] parseSpsResolution 抛异常，使用默认分辨率');
      }
      console.log('[H264Player] buildInitFromFragment 兜底: codec:', this.codecString, '分辨率:', resolution);
      const init = buildInitManual(avcC, resolution.width, resolution.height);
      this.initSegment = init.buffer as ArrayBuffer;
      const ok = this.initSourceBuffer();
      if (ok) {
        this.initReady = true;
      } else {
        console.log('[H264Player] buildInitFromFragment 兜底: SourceBuffer 创建失败，等待重试');
      }
    } else {
      // 从 fragment 中也提取不到 SPS/PPS，使用默认 codec
      this.codecString = 'avc1.42E01E';
      console.warn('[H264Player] buildInitFromFragment: 无法提取 SPS/PPS，使用默认 codec');
      this.initReady = true;
      // 没有 init segment 可以 append，直接尝试 append fragment
    }
  }

  private doAppend(data: ArrayBuffer) {
    if (!this.sourceBuffer) {
      this.pendingChunks.push(data);
      // 限制 pendingChunks 大小，防止内存无限增长
      if (this.pendingChunks.length > 50) {
        console.warn('[H264Player] pendingChunks 过多 (' + this.pendingChunks.length + ')，丢弃旧数据');
        this.pendingChunks = this.pendingChunks.slice(-20);
      }
      return;
    }
    if (this.sourceBuffer.updating) {
      this.pendingChunks.push(data);
      if (this.pendingChunks.length > 50) {
        console.warn('[H264Player] pendingChunks 过多 (' + this.pendingChunks.length + ')，丢弃旧数据');
        this.pendingChunks = this.pendingChunks.slice(-20);
      }
      return;
    }
    // 检查 video element 是否处于 error 状态
    if (this.videoElement?.error) {
      const err = this.videoElement.error;
      console.error('[H264Player] video element 处于 error 状态, code:', err?.code, 'message:', err?.message, '尝试完全重置 MediaSource');
      this.fullResetMediaSource();
      this.pendingChunks.push(data);
      return;
    }
    try {
      this.sourceBuffer.appendBuffer(data);
      this.fragmentCount++;
      if (this.fragmentCount === 1) {
        console.log('[H264Player] 首个 fragment 已 append, size:', data.byteLength);
      }
    } catch (e: any) {
      const isMediaError = e?.message?.includes('HTMLMediaElement.error');
      console.error('[H264Player] appendBuffer failed:', e?.message || e, 'dataSize:', data.byteLength, 'fragmentIndex:', this.fragmentCount, 'codec:', this.codecString);
      if (isMediaError) {
        // video element 进入 error 状态，需要完全重置
        console.error('[H264Player] 检测到 media element error，触发完全重置');
        this.fullResetMediaSource();
      } else if (this.mediaSource && this.mediaSource.readyState === 'open' && this.sourceBuffer) {
        try {
          this.sourceBuffer.abort();
        } catch { /* noop */ }
      }
      this.pendingChunks.push(data);
    }
  }

  private tryStartStream() {
    // 只需要 socket 就绪，不需要等待 sourceBuffer（数据可以先缓存到 pendingChunks）
    if (!this.socketReady || !this.socket?.connected) {
      return;
    }
    if (this.streamStarted) {
      return;
    } // 避免重复发送
    this.streamStarted = true;

    const token = localStg.get('token');
    this.socket.emit('start_stream', {
      project_id: this.options.projectId,
      token
    }, (response: any) => {
      if (response?.error) {
        this.options.onError?.(response.error);
      }
    });

    // 发送查询配置请求，让后台返回摄像头当前分辨率/codec
    this.socket.emit('query_config', {
      project_id: this.options.projectId
    });
    console.log('[H264Player] 已发送 query_config 请求');

    // 超时：如果 5 秒内没收到 config_response，使用本地 SPS 解析兜底
    this._configTimeout = setTimeout(() => {
      if (!this.remoteConfigReady) {
        console.warn('[H264Player] query_config 超时（5秒），将使用本地 SPS 解析兜底');
        this.remoteConfigReady = true; // 标记为就绪（兜底模式）
      }
    }, 5000);

    // 超时检测：后台应在 stream_info 后 2-5 秒内发送首个 video_data
    // 这里设置 10 秒作为安全阈值
    setTimeout(() => {
      if (!this.attached) {
        return;
      }
      if (!this.initReady) {
        const hasData = this._videoDataCount > 0;
        const msg = hasData
          ? `视频流初始化超时：已收到 ${this._videoDataCount} 个数据包但无法完成初始化，可能数据格式异常`
          : '视频流连接超时：10 秒内未收到任何视频数据。\n可能原因：1) 后台 ffmpeg 推流进程启动失败 2) 摄像头设备不可用 3) 网络问题。建议检查后台日志并尝试重启后台服务。';
        console.error('[H264Player] 超时：start_stream 后 10 秒，videoDataCount:', this._videoDataCount, 'initReady:', this.initReady);
        this.options.onError?.(msg);
      }
    }, 10000);
  }

  private flushPendingChunks() {
    if (this.pendingChunks.length === 0) {
      return;
    }
    while (this.pendingChunks.length > 0 && this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        if (this.sourceBuffer.buffered.length > 0) {
          const end = this.sourceBuffer.buffered.end(this.sourceBuffer.buffered.length - 1);
          const start = this.sourceBuffer.buffered.start(0);
          if (end - start > 30) {
            this.sourceBuffer.remove(start, start + 10);
            break;
          }
        }

        const chunk = this.pendingChunks.shift()!;
        this.sourceBuffer.appendBuffer(chunk);

        if (this.videoElement && this.videoElement.paused) {
          this.videoElement.play().catch(() => {});
        }
      } catch (e) {
        console.warn('[H264Player] flushPendingChunks 失败:', e);
        break;
      }
    }
  }

  destroy() {
    this.attached = false;
    this.streamStarted = false;
    if (this._configTimeout) {
      clearTimeout(this._configTimeout);
      this._configTimeout = null;
    }
    // 先移除所有 Socket 监听器，防止 destroy 后还有回调触发
    if (this.socket) {
      this.socket.off('video_data');
      this.socket.off('config_response');
      this.socket.off('config_changed');
      this.socket.off('stream_info');
      this.socket.off('stream_end');
      this.socket.off('error');
      this.socket.off('disconnect');
      this.socket.off('connect_error');
      this.socket.off('connect');
      if (this.socket.connected) {
        this.socket.emit('stop_stream', { project_id: this.options.projectId });
        this.socket.disconnect();
      }
    }
    this.socket = null;
    // 先清理 SourceBuffer，再关闭 MediaSource
    if (this.sourceBuffer) {
      try {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        }
      } catch { /* noop */ }
      this.sourceBuffer = null;
    }
    // 关闭 MediaSource（触发 sourceclose）
    if (this.mediaSource && this.mediaSource.readyState !== 'closed') {
      try {
        this.mediaSource.endOfStream();
      } catch { /* noop */ }
    }
    // 清理 video 元素：先清空 src，释放 blob URL，再 load() 重置
    if (this.videoElement) {
      try {
        this.videoElement.pause();
        this.videoElement.src = '';
        this.videoElement.load();
      } catch { /* noop */ }
      this.videoElement = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.mediaSource = null;
    this.pendingChunks = [];
    this.segmentBuffer = [];
    this.segmentBufferSize = 0;
    this.remoteConfig = null;
    this.remoteConfigReady = false;
    this.initReady = false;
    this.initSegment = null;
    this.codecString = null;
    this.socketReady = false;
    this.fragmentCount = 0;
    this._videoDataCount = 0;
    this._firstVideoDataReceived = undefined;
    this._resetting = false;
  }
}

/**
 * 从 fMP4 moof+mdat segment 中仅提取 SPS/PPS 信息
 * 不篡改原始数据
 */
function extractSpsPpsOnly(data: ArrayBuffer): { sps: Uint8Array; pps: Uint8Array } | null {
  const view = new Uint8Array(data);

  // 从 moov 中提取 avcC
  const avcCFromMoov = extractAvcCFromMoov(view);
  if (avcCFromMoov) {
    const sps = extractSpsFromAvcC(avcCFromMoov);
    const pps = extractPpsFromAvcC(avcCFromMoov);
    if (sps && pps) {
      return { sps, pps };
    }
  }

  // 从 mdat 中提取（长度前缀格式）
  const mdatData = findMdatData(view);
  if (mdatData) {
    const result = extractSpsPpsFromLengthPrefixed(mdatData);
    if (result) {
      return result;
    }
  }

  // fallback: 搜索 start-code
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (let i = 0; i < view.length - 5; i++) {
    let startCodeLen = 0;
    if (view[i] === 0 && view[i + 1] === 0 && view[i + 2] === 0 && view[i + 3] === 1) {
      startCodeLen = 4;
    } else if (view[i] === 0 && view[i + 1] === 0 && view[i + 2] === 1) {
      startCodeLen = 3;
    }
    if (startCodeLen > 0) {
      const nalType = view[i + startCodeLen] & 0x1f;
      let end = view.length;
      for (let j = i + startCodeLen + 1; j < view.length - 4; j++) {
        if (view[j] === 0 && view[j + 1] === 0 && (view[j + 2] === 1 || (view[j + 2] === 0 && view[j + 3] === 1))) {
          end = j;
          break;
        }
      }
      const nalData = view.slice(i + startCodeLen, end);
      if (nalType === 7 && !sps) {
        sps = nalData; 
      } else if (nalType === 8 && !pps) {
        pps = nalData; 
      }
      if (sps && pps) {
        return { sps, pps };
      }
      i = end;
    }
  }

  return null;
}

/** 检查 buffer 中是否包含 moov box */
function containsMoov(view: Uint8Array): boolean {
  for (let i = 0; i < view.length - 8; i++) {
    if (view[i] === 0x6d && view[i + 1] === 0x6f && view[i + 2] === 0x6f && view[i + 3] === 0x76) {
      return true;
    }
  }
  return false;
}

/** 在 buffer 中查找指定类型 box 的偏移，返回偏移或 -1 */
function findBoxTypeIndex(view: Uint8Array, startOffset: number, type: string): number {
  const typeBytes = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  for (let i = startOffset; i < view.length - 8; i++) {
    if (view[i + 4] === typeBytes[0] && view[i + 5] === typeBytes[1] &&
        view[i + 6] === typeBytes[2] && view[i + 7] === typeBytes[3]) {
      return i;
    }
  }
  return -1;
}

/** 在 buffer 中定位 mdat box，返回 mdat 中的数据部分 */
function findMdatData(view: Uint8Array): Uint8Array | null {
  for (let i = 0; i < view.length - 8; i++) {
    if (view[i] === 0x6d && view[i + 1] === 0x64 && view[i + 2] === 0x61 && view[i + 3] === 0x74) {
      // 找到了 "mdat" 标识
      // mdat 的 box size 在前 4 字节（如果 size 为 0 表示延伸到文件末尾）
      const boxSize = (view[i - 4] << 24) | (view[i - 3] << 16) | (view[i - 2] << 8) | view[i - 1];
      // mdat 数据从标识之后开始
      const dataStart = i + 4;
      // 如果 boxSize 太大（超出 buffer）或为 0，使用 buffer 剩余部分
      const dataEnd = (boxSize === 0 || boxSize > view.length - i + 4)
        ? view.length
        : Math.min(dataStart + boxSize - 8, view.length);
      return view.slice(dataStart, dataEnd);
    }
  }
  return null;
}

/** 从长度前缀格式的 buffer 中提取 SPS/PPS */
function extractSpsPpsFromLengthPrefixed(view: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let offset = 0;

  // fMP4 mdat 中的 H.264 数据：每个 NAL unit 前面有 4 字节大端长度
  while (offset + 4 < view.length) {
    const nalLen = (view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3];
    offset += 4;
    if (offset + nalLen > view.length) {
      break;
    }

    // 合理的 NAL 长度范围
    if (nalLen > 0 && nalLen < 1024 * 1024) {
      const nalType = view[offset] & 0x1f;

      if (nalType === 7 && !sps) {
        sps = view.slice(offset, offset + nalLen);
      } else if (nalType === 8 && !pps) {
        pps = view.slice(offset, offset + nalLen);
      }
      if (sps && pps) {
        return { sps, pps };
      }
    }
    offset += nalLen;
  }
  return sps && pps ? { sps, pps } : null;
}

/** 在 buffer 中搜索 moov -> trak -> stsd -> avc1 -> avcC */
function extractAvcCFromMoov(view: Uint8Array): Uint8Array | null {
  // 搜索 "avcC" 四字节
  for (let i = 0; i < view.length - 8; i++) {
    if (view[i] === 0x61 && view[i + 1] === 0x76 && view[i + 2] === 0x63 && view[i + 3] === 0x43) {
      // 前 4 字节应该是 box size
      const size = (view[i - 4] << 24) | (view[i - 3] << 16) | (view[i - 2] << 8) | view[i - 1];
      if (size > 8 && size <= view.length - i + 4) {
        return view.slice(i, i + size - 8);
      }
    }
  }
  return null;
}

/** 从 moov box 中直接提取宽高（从 tkhd 或 avc1 box，比 SPS bit 解析更可靠） */
function extractResolutionFromMoov(view: Uint8Array): { width: number; height: number } | null {
  // 方法 1：从 tkhd box 中提取
  // tkhd FullBox 布局（version 0）：
  //   size(4) + type(4) + version(1) + flags(3) + creation_time(4) + modification_time(4)
  //   + track_id(4) + reserved(4) + duration(4) + reserved(8)
  //   + layer(2) + alternate_group(2) + volume(2) + reserved(2) + matrix(36)
  //   + width(4) + height(4)
  // 从 tkhd 标识开始偏移: 4+3+4+4+4+4+4+8+2+2+2+2+36 = 79
  // 所以 width 在 tkhd标识+80, height 在 tkhd标识+84
  //
  // tkhd FullBox 布局（version 1）：
  //   creation_time(8) + modification_time(8) + duration(8) → 多 12 字节
  //   所以 width 在 tkhd标识+92, height 在 tkhd标识+96
  for (let i = 0; i < view.length - 96; i++) {
    if (view[i] === 0x74 && view[i + 1] === 0x6B && view[i + 2] === 0x68 && view[i + 3] === 0x64) {
      const version = view[i + 4]; // FullBox version byte
      let wOff: number, hOff: number;
      if (version === 1) {
        wOff = i + 92;
        hOff = i + 96;
      } else {
        wOff = i + 80;
        hOff = i + 84;
      }
      if (hOff + 4 <= view.length) {
        const width = (view[wOff] << 24) | (view[wOff + 1] << 16) |
                      (view[wOff + 2] << 8) | view[wOff + 3];
        const height = (view[hOff] << 24) | (view[hOff + 1] << 16) |
                       (view[hOff + 2] << 8) | view[hOff + 3];
        // tkhd 中的宽高是 16.16 定点数，取整数部分
        const w = width / 0x10000;
        const h = height / 0x10000;
        if (w > 0 && h > 0 && w < 10000 && h < 10000) {
          return { width: Math.round(w), height: Math.round(h) };
        }
      }
    }
  }

  // 方法 2：从 avc1 box 中提取（width/height 在 avc1 标识偏移 + 24 处，各 2 字节）
  for (let i = 0; i < view.length - 30; i++) {
    if (view[i] === 0x61 && view[i + 1] === 0x76 && view[i + 2] === 0x63 && view[i + 3] === 0x31) {
      const wOff = i + 24;
      const hOff = i + 26;
      if (hOff + 2 <= view.length) {
        const w = (view[wOff] << 8) | view[wOff + 1];
        const h = (view[hOff] << 8) | view[hOff + 1];
        if (w > 0 && h > 0 && w < 10000 && h < 10000) {
          return { width: w, height: h };
        }
      }
    }
  }

  return null;
}

/** 从 avcC 中提取 SPS */
function extractSpsFromAvcC(avcC: Uint8Array): Uint8Array | null {
  if (avcC.length < 8) {
    return null;
  }
  // avcC[0]=configVersion, avcC[1..3]=profile, avcC[4]=lengthSize, avcC[5]=numSPS(低5位)
  const numSPS = avcC[5] & 0x1f;
  if (numSPS < 1) {
    return null;
  }
  let offset = 6;
  const spsLen = (avcC[offset] << 8) | avcC[offset + 1];
  offset += 2;
  if (offset + spsLen > avcC.length) {
    return null;
  }
  return avcC.slice(offset, offset + spsLen);
}

/** 从 avcC 中提取 PPS */
function extractPpsFromAvcC(avcC: Uint8Array): Uint8Array | null {
  // 先跳过 SPS
  if (avcC.length < 8) {
    return null;
  }
  const numSPS = avcC[5] & 0x1f;
  if (numSPS < 1) {
    return null;
  }
  let offset = 6;
  const spsLen = (avcC[offset] << 8) | avcC[offset + 1];
  offset += 2 + spsLen;
  if (offset >= avcC.length) {
    return null;
  }
  const numPPS = avcC[offset++];
  if (numPPS < 1) {
    return null;
  }
  const ppsLen = (avcC[offset] << 8) | avcC[offset + 1];
  offset += 2;
  if (offset + ppsLen > avcC.length) {
    return null;
  }
  return avcC.slice(offset, offset + ppsLen);
}

/** 从 SPS NAL unit 解析宽高（全部使用 bit-level 解析） */
function parseSpsResolution(sps: Uint8Array): { width: number; height: number } {
  try {
    if (sps.length < 8) {
      return { width: 1920, height: 1080 };
    }

    // 诊断日志
    const spsHex = Array.from(sps).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('[H264Player] parseSpsResolution SPS hex (' + sps.length + ' bytes):', spsHex);

    // 从 bit 1*8=8 开始（跳过 1 字节 NAL header）
    let pos = 8;

    const profileIdc = readBits(sps, pos, 8).value; pos += 8;
    const constraintFlags = readBits(sps, pos, 8).value; pos += 8;
    const levelIdc = readBits(sps, pos, 8).value; pos += 8;
    console.log('[H264Player] parseSpsResolution: profileIdc:', profileIdc, 'constraintFlags:', constraintFlags.toString(16), 'levelIdc:', levelIdc, 'pos:', pos);
    // seq_parameter_set_id (ue)
    const spsId = safeReadUE(sps, pos);
    pos = spsId.pos;
    console.log('[H264Player] parseSpsResolution: sps_id:', spsId.value, 'pos:', pos);

    // 检查是否是特定 profile（需要额外解析 chroma format 等）
    if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 || profileIdc === 244 ||
        profileIdc === 44 || profileIdc === 83 || profileIdc === 86 || profileIdc === 118 || profileIdc === 128) {
      const chromaResult = safeReadUE(sps, pos);
      pos = chromaResult.pos;
      console.log('[H264Player] parseSpsResolution: chroma_format_idc:', chromaResult.value, 'pos:', pos);
      if (chromaResult.value === 3) {
        pos++; // separate_colour_plane_flag (1 bit)
      }
      const bitDepthLuma = safeReadUE(sps, pos);
      pos = bitDepthLuma.pos;
      const bitDepthChroma = safeReadUE(sps, pos);
      pos = bitDepthChroma.pos;
      console.log('[H264Player] parseSpsResolution: bit_depth_luma_minus8:', bitDepthLuma.value, 'bit_depth_chroma_minus8:', bitDepthChroma.value, 'pos:', pos);
      pos++; // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresentFlag = readBits(sps, pos, 1).value; pos++;
      if (seqScalingMatrixPresentFlag) {
        // 跳过 scaling matrix（简化处理，最多跳过 8*8*2*6 = 768 bits = 96 bytes）
        pos = Math.min(pos + 768, sps.length * 8);
      }
    }
    pos = safeSkipUE(sps, pos); // log2_max_frame_num_minus4

    const picOrderCntType = safeReadUE(sps, pos);
    pos = picOrderCntType.pos;
    if (picOrderCntType.value === 0) {
      pos = safeSkipUE(sps, pos); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType.value === 1) {
      pos++; // delta_pic_order_always_zero_flag (1 bit)
      pos = safeSkipSE(sps, pos); // offset_for_non_ref_pic
      pos = safeSkipSE(sps, pos); // offset_for_top_to_bottom_field
      const numRef = safeReadUE(sps, pos);
      pos = numRef.pos;
      for (let i = 0; i < Math.min(numRef.value, 10); i++) {
        pos = safeSkipSE(sps, pos); // offset_for_ref_frame[i]
      }
    }
    pos = safeSkipUE(sps, pos); // max_num_ref_frames
    pos++; // gaps_in_frame_num_value_allowed_flag (1 bit)

    const picWidthResult = safeReadUE(sps, pos);
    pos = picWidthResult.pos;
    const picHeightResult = safeReadUE(sps, pos);
    pos = picHeightResult.pos;
    console.log('[H264Player] parseSpsResolution: picWidthMbs:', picWidthResult.value, 'picHeightMbs:', picHeightResult.value, 'pos:', pos);

    // 边界检查
    if (!isFinite(picWidthResult.value) || !isFinite(picHeightResult.value) ||
        picWidthResult.value < 0 || picHeightResult.value < 0) {
      return { width: 1920, height: 1080 };
    }

    // frame_mbs_only_flag (1 bit)
    const frameMbsOnlyFlag = readBits(sps, pos, 1).value; pos++;
    let height = (picHeightResult.value + 1) * 16;
    if (frameMbsOnlyFlag === 0) {
      pos++; // mb_adaptive_frame_field_flag (1 bit)
      height = (picHeightResult.value + 1) * 16 * 2;
    }

    const width = (picWidthResult.value + 1) * 16;

    // frame_cropping_flag (1 bit) — 如果为 1，后面有裁剪参数
    let cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
    const frameCroppingFlag = readBits(sps, pos, 1).value; pos++;
    if (frameCroppingFlag) {
      cropLeft = safeReadUE(sps, pos).value; pos = safeSkipUE(sps, pos);
      cropRight = safeReadUE(sps, pos).value; pos = safeSkipUE(sps, pos);
      cropTop = safeReadUE(sps, pos).value; pos = safeSkipUE(sps, pos);
      cropBottom = safeReadUE(sps, pos).value; pos = safeSkipUE(sps, pos);
    }

    // 应用裁剪
    const subWidthC = 2; // 对于 4:2:0 chroma format
    const subHeightC = (frameMbsOnlyFlag === 0) ? 1 : 2;
    const cropUnitX = subWidthC;
    const cropUnitY = subHeightC * (2 - frameMbsOnlyFlag);

    const displayWidth = width - cropUnitX * (cropLeft + cropRight);
    const displayHeight = height - cropUnitY * (cropTop + cropBottom);

    const result = { width: Math.round(displayWidth), height: Math.round(displayHeight) };
    console.log('[H264Player] parseSpsResolution 结果: width:', result.width, 'height:', result.height, '(raw w:', width, 'h:', height, 'crop L:', cropLeft, 'R:', cropRight, 'T:', cropTop, 'B:', cropBottom, ')');
    return result;
  } catch {
    return { width: 1920, height: 1080 };
  }
}

function safeReadUE(buf: Uint8Array, pos: number): { value: number; pos: number } {
  if (pos >= buf.length * 8) {
    return { value: 0, pos: buf.length * 8 };
  }
  try {
    return readUE(buf, pos);
  } catch {
    return { value: 0, pos: buf.length * 8 };
  }
}
function safeSkipUE(buf: Uint8Array, pos: number): number {
  return safeReadUE(buf, pos).pos;
}
function safeSkipSE(buf: Uint8Array, pos: number): number {
  if (pos >= buf.length * 8) {
    return buf.length * 8;
  }
  try {
    return readSE(buf, pos).pos;
  } catch {
    return buf.length * 8;
  }
}

function readBits(buf: Uint8Array, pos: number, n: number): { value: number; pos: number } {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const byteIdx = (pos + i) >> 3;
    if (byteIdx >= buf.length) {
      return { value: 0, pos: buf.length * 8 };
    }
    const bitIdx = 7 - ((pos + i) & 7);
    value = (value << 1) | ((buf[byteIdx] >> bitIdx) & 1);
  }
  return { value, pos: pos + n };
}

function readUE(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let leadingZeroBits = 0;
  while (true) {
    const b = readBits(buf, pos, 1);
    pos = b.pos;
    if (b.value === 0) {
      leadingZeroBits++;
    } else {
      break;
    }
  }
  let value = 0;
  for (let i = 0; i < leadingZeroBits; i++) {
    const b = readBits(buf, pos, 1);
    pos = b.pos;
    value = (value << 1) | b.value;
  }
  value += (1 << leadingZeroBits) - 1;
  return { value, pos };
}

function readSE(buf: Uint8Array, pos: number): { value: number; pos: number } {
  const ue = readUE(buf, pos);
  const v = ue.value;
  const signed = v % 2 === 0 ? -(v / 2) : (v + 1) / 2;
  return { value: signed, pos: ue.pos };
}

/** 从 SPS 和 PPS NAL units 构建 avcC box */
function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  // avcC 结构:
  // configurationVersion(1) | AVCProfileIndication(1) | profile_compatibility(1) | AVCLevelIndication(1)
  // | reserved(6) | lengthSizeMinusOne(2) | reserved(3) | numOfSequenceParameterSets(5)
  // | SPS: sequenceParameterSetLength(2) + data
  // | numOfPictureParameterSets(1)
  // | PPS: pictureParameterSetLength(2) + data
  // 总大小: 5 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length
  const totalSize = 5 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length;

  const avcC = new Uint8Array(totalSize);
  let offset = 0;
  avcC[offset++] = 0x01; // configurationVersion
  avcC[offset++] = sps[1]; // AVCProfileIndication (from SPS)
  avcC[offset++] = sps[2]; // profile_compatibility
  avcC[offset++] = sps[3]; // AVCLevelIndication
  avcC[offset++] = 0xff; // reserved(6) | lengthSizeMinusOne(2) = 11 => 0xff
  avcC[offset++] = 0xe1; // reserved(3) | numOfSequenceParameterSets(5) = 1
  // SPS length (2 bytes)
  avcC[offset++] = (sps.length >> 8) & 0xff;
  avcC[offset++] = sps.length & 0xff;
  avcC.set(sps, offset); offset += sps.length;
  avcC[offset++] = 0x01; // numOfPictureParameterSets
  // PPS length (2 bytes)
  avcC[offset++] = (pps.length >> 8) & 0xff;
  avcC[offset++] = pps.length & 0xff;
  avcC.set(pps, offset); offset += pps.length;

  return avcC.slice(0, offset);
}

/**
 * 从 codec 字符串（如 "avc1.42E01E"）构建最小 avcC box
 * 用于当后台只返回了 codec 字符串但没有原始 SPS/PPS 数据时
 */
function buildAvcCFromCodecString(codec: string): Uint8Array {
  // 解析 codec 字符串：avc1.XXYYZZ -> profile=XX, compat=YY, level=ZZ
  let profile = 0x42; // baseline
  let compat = 0xE0;
  let level = 0x1E; // level 3.0
  const match = codec.match(/avc1\.([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})/);
  if (match) {
    profile = parseInt(match[1], 16);
    compat = parseInt(match[2], 16);
    level = parseInt(match[3], 16);
  }

  // 构建最小 avcC（无 SPS/PPS，仅含必要 header）
  const avcC = new Uint8Array(7);
  avcC[0] = 0x01; // configurationVersion
  avcC[1] = profile; // AVCProfileIndication
  avcC[2] = compat; // profile_compatibility
  avcC[3] = level; // AVCLevelIndication
  avcC[4] = 0xff; // reserved + lengthSizeMinusOne = 3 (4 bytes)
  avcC[5] = 0xe0; // reserved + numOfSequenceParameterSets = 0
  avcC[6] = 0x00; // numOfPictureParameterSets = 0
  return avcC;
}

/** 纯手动构建 init segment（不使用任何库的 box API） */
function buildInitManual(avcC: Uint8Array, width: number, height: number): Uint8Array {
  const buf: number[] = [];

  function u32(v: number) {
    buf.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); 
  }
  function u16(v: number) {
    buf.push((v >> 8) & 0xff, v & 0xff); 
  }
  function u8(v: number) {
    buf.push(v & 0xff); 
  }
  function str(s: string) {
    for (let i = 0; i < 4; i++) {
      u8(s.charCodeAt(i));
    } 
  }
  function box(type: string, fn: () => void) {
    const start = buf.length;
    u32(0); str(type); fn();
    const end = buf.length;
    const size = end - start;
    buf[start] = (size >> 24) & 0xff;
    buf[start + 1] = (size >> 16) & 0xff;
    buf[start + 2] = (size >> 8) & 0xff;
    buf[start + 3] = size & 0xff;
  }
  function fbox(type: string, ver: number, flags: number, fn: () => void) {
    const start = buf.length;
    u32(0); str(type); u8(ver); u8((flags >> 16) & 0xff); u8((flags >> 8) & 0xff); u8(flags & 0xff); fn();
    const end = buf.length;
    const size = end - start;
    buf[start] = (size >> 24) & 0xff;
    buf[start + 1] = (size >> 16) & 0xff;
    buf[start + 2] = (size >> 8) & 0xff;
    buf[start + 3] = size & 0xff;
  }

  // ftyp
  box('ftyp', () => {
    str('isom'); u32(1); str('isom'); str('avc1');
  });

  // moov
  box('moov', () => {
    // mvhd — timescale 与 mdhd 保持一致
    fbox('mvhd', 0, 0, () => {
      u32(0); u32(0); u32(90000); u32(0);
      u32(0x00010000); u16(0x0100); u16(0);
      u32(0); u32(0);
      // matrix
      u32(0x00010000); u32(0); u32(0);
      u32(0); u32(0x00010000); u32(0);
      u32(0); u32(0); u32(0x40000000);
      for (let i = 0; i < 6; i++) {
        u32(0);
      }
      u32(2); // next_track_id
    });

    // mvex (Movie Extends — 必须！fMP4 要求 moov 包含 mvex)
    box('mvex', () => {
      // trex (Track Extends)
      fbox('trex', 0, 0, () => {
        u32(1); // track_id
        u32(1); // default_sample_description_index
        u32(0); // default_sample_duration
        u32(0); // default_sample_size
        u32(0); // default_sample_flags
      });
    });

    // trak
    box('trak', () => {
      // tkhd
      fbox('tkhd', 0, 7, () => {
        u32(0); u32(0); u32(1); u32(0); u32(0); u32(0); u32(0);
        u16(0); u16(0); u16(0x0100); u16(0);
        u32(0x00010000); u32(0); u32(0);
        u32(0); u32(0x00010000); u32(0);
        u32(0); u32(0); u32(0x40000000);
        u32(width * 0x10000); u32(height * 0x10000);
      });

      // mdia
      box('mdia', () => {
        // mdhd — 使用 H.264 标准 timescale 90000，与后端 moof tfdt 对齐
        fbox('mdhd', 0, 0, () => {
          u32(0); u32(0); u32(90000); u32(0);
          u16(0x55c4); u16(0);
        });

        // hdlr
        fbox('hdlr', 0, 0, () => {
          u32(0); str('vide'); u32(0); u32(0); u32(0); u8(0);
        });

        // minf
        box('minf', () => {
          // vmhd
          fbox('vmhd', 0, 1, () => {
            u16(0); u16(0); u16(0); u16(0);
          });

          // dinf
          box('dinf', () => {
            fbox('dref', 0, 0, () => {
              u32(1);
              // url entry
              box('url ', () => {
                u8(0); u8(0); u8(0); u8(1);
              });
            });
          });

          // stbl
          box('stbl', () => {
            // stsd
            fbox('stsd', 0, 0, () => {
              u32(1);
              // avc1 entry
              box('avc1', () => {
                for (let i = 0; i < 6; i++) {
                  u8(0);
                } // reserved
                u16(1); // data_reference_index
                u16(0); u16(0); u32(0); u32(0); u32(0);
                u16(width); u16(height);
                u32(0x00480000); u32(0x00480000);
                u32(0); u16(1);
                u8(0); // compressor name length
                for (let i = 0; i < 31; i++) {
                  u8(0);
                }
                u16(0x0018); u16(0xffff);

                // avcC
                box('avcC', () => {
                  for (let i = 0; i < avcC.length; i++) {
                    u8(avcC[i]);
                  }
                });
              });
            });

            // stts (empty)
            fbox('stts', 0, 0, () => {
              u32(0); 
            });
            // stsc (empty)
            fbox('stsc', 0, 0, () => {
              u32(0); 
            });
            // stsz (empty)
            fbox('stsz', 0, 0, () => {
              u32(0); u32(0); 
            });
            // stco (empty)
            fbox('stco', 0, 0, () => {
              u32(0); 
            });
          });
        });
      });
    });
  });

  return new Uint8Array(buf);
}


