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
  console.log('[H264Player] SPS profile:', hex(profile), 'compat:', hex(compat), 'level:', hex(level), '=> codec:', codec);
  return codec;
}

export class H264Player {
  private socket: Socket | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private videoElement: HTMLVideoElement | null = null;
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
      console.error('[H264Player] video error:', err?.code, err?.message);
    });

    video.addEventListener('loadedmetadata', () => {
      console.log('[H264Player] video loadedmetadata, duration:', video.duration);
    });

    video.addEventListener('canplay', () => {
      console.log('[H264Player] video canplay, readyState:', video.readyState);
    });

    video.addEventListener('playing', () => {
      console.log('[H264Player] video playing');
    });

    video.addEventListener('waiting', () => {
      console.log('[H264Player] video waiting');
    });

    this.connectSocket();

    this.mediaSource = new MediaSource();
    video.src = URL.createObjectURL(this.mediaSource);

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.attached || !this.mediaSource || this.mediaSource.readyState !== 'open') {
        return;
      }
      // 不立即创建 SourceBuffer，等到从第一个 segment 中解析出 SPS/PPS 后，
      // 用正确的 codec 字符串来创建 SourceBuffer
      // 如果此时 init segment 已经就绪（在 sourceopen 之前就已收到），立即初始化
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
  private initSourceBuffer() {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open' || !this.codecString) {
      return;
    }
    if (this.sourceBuffer) {
      return;
    } // 已经初始化过了

    try {
      const mime = `video/mp4; codecs="${this.codecString}"`;
      if (!MediaSource.isTypeSupported(mime)) {
        console.error('[H264Player] 浏览器不支持 codec:', mime);
        this.options.onError?.(`浏览器不支持编码 ${this.codecString}`);
        return;
      }
      console.log('[H264Player] 使用 codec:', mime);
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
      this.sourceBuffer.mode = 'sequence';

      this.sourceBuffer.addEventListener('updateend', () => {
        this.flushPendingChunks();
      });

      this.sourceBuffer.addEventListener('error', (e) => {
        console.error('[H264Player] SourceBuffer error:', e);
        // 尝试结束流以防止 MediaSource 永久损坏
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream(); 
          } catch { /* noop */ }
        }
      });

      // append init segment
      if (this.initSegment) {
        const initView = new Uint8Array(this.initSegment);
        console.log('[H264Player] append init segment, 大小:', initView.byteLength);
        // 打印 init segment 前 128 字节用于调试
        const hexDump = Array.from(initView.slice(0, Math.min(128, initView.byteLength)))
          .map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log('[H264Player] init segment hex (前128):', hexDump);
        this.sourceBuffer.appendBuffer(this.initSegment);
      }
    } catch (e) {
      this.options.onError?.(`MSE 初始化失败: ${e}`);
    }
  }

  private connectSocket() {
    const serverUrl = globalConfig.serviceBaseURL.replace(/\/api$/, '');
    const token = localStg.get('token') || '';
    const namespace = '/ws/camera';

    console.log('[H264Player] 连接 Socket.IO: serverUrl:', serverUrl, 'namespace:', namespace, 'path:', '/socket.io');
    console.log('[H264Player] 完整 URL:', `${serverUrl}${namespace}`);

    this.socket = io(`${serverUrl}${namespace}`, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
      query: { token }
    });

    // 打印 Socket.IO 内部握手信息（引擎层）
    this.socket.io.on('open', () => {
      console.log('[H264Player] 底层 WebSocket 已打开');
    });

    this.socket.on('connect', () => {
      console.log('[H264Player] Socket.IO 已连接, socket.id:', this.socket?.id);
      this.socketReady = true;
      this.tryStartStream();
    });

    // 监听所有事件用于调试（不过滤，全部打印）
    this.socket.onAny((event, ...args) => {
      if (['connect', 'disconnect', 'connect_error'].includes(event)) {
        return;
      }
      // 打印前 256 字节数据用于调试
      const argInfo = args.map((a: any) => {
        if (a instanceof ArrayBuffer) {
          const bytes = new Uint8Array(a, 0, Math.min(a.byteLength, 256));
          const hex = Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
          return `[Binary ${a.byteLength}bytes, first 16: ${hex}]`;
        }
        if (ArrayBuffer.isView(a)) {
          const view = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
          const hex = Array.from(view.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
          return `[Binary ${a.byteLength}bytes, first 16: ${hex}]`;
        }
        return typeof a === 'object' ? JSON.stringify(a).substring(0, 200) : String(a).substring(0, 200);
      });
      console.log('[H264Player] 事件:', event, 'args:', argInfo);
    });

    this.socket.on('stream_info', (info: any) => {
      console.log('[H264Player] stream_info:', info);
      this.options.onStatusChange?.('connected');
    });

    this.socket.on('video_data', (chunk: any) => {
      let data: ArrayBuffer | null = null;
      if (chunk instanceof ArrayBuffer) {
        data = chunk;
      } else if (ArrayBuffer.isView(chunk)) {
        data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      } else {
        console.warn('[H264Player] video_data 类型异常:', typeof chunk, chunk);
        return;
      }

      // 将 chunk 加入分段拼接缓冲区
      this.segmentBuffer.push(new Uint8Array(data));
      this.segmentBufferSize += data.byteLength;

      // 尝试从缓冲区中提取完整的 fMP4 segment
      this.tryExtractSegment();
    });

    this.socket.on('stream_end', () => {
      console.log('[H264Player] stream_end');
      this.options.onStatusChange?.('disconnected');
    });

    this.socket.on('error', (data: { message?: string }) => {
      console.error('[H264Player] Socket error:', data);
      this.options.onError?.(data?.message || '未知错误');
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[H264Player] Socket disconnect, reason:', reason);
      this.options.onStatusChange?.('disconnected');
    });

    this.socket.on('connect_error', (err) => {
      console.error('[H264Player] Socket connect_error:', err?.message, err);
      this.options.onError?.(`Socket.IO 连接失败: ${  err?.message || ''}`);
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
        // segment 还没收完，继续等待
        if (this.segmentBuffer.length > 1) {
          console.log(`[H264Player] 拼接中: buffer=${  this.segmentBufferSize  } 需要=${  totalSegmentSize 
          } (moof=${  boxSize  } mdat=${  mdatSize  })`);
        }
        return;
      }

      // segment 完整，提取并处理
      console.log(`[H264Player] segment 完整: buffer=${  this.segmentBufferSize 
      } 需要=${  totalSegmentSize  } (moof=${  boxSize  } mdat=${  mdatSize  })`);

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
        this.handleFirstSegment(segmentData);
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
          } else {
            this.doAppend(segmentData);
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
    console.log('[H264Player] 首个 segment, 大小:', view.byteLength);

    // 打印前 64 字节 hex 用于诊断
    const hexLen = Math.min(view.byteLength, 64);
    const hex = Array.from(view.slice(0, hexLen)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[H264Player] 首个 segment hex (前${  hexLen  }字节):`, hex);

    // 检查是否是 init segment（以 ftyp 开头）
    if (view.byteLength >= 8 && view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
      // 检查这个 segment 是否包含 moov（含有 codec 信息）
      const hasMoov = containsMoov(view);
      if (hasMoov) {
        // 完整 init segment: ftyp + moov，从 moov 中提取 SPS/PPS 来确定 codec
        console.log(`[H264Player] 首个 segment 是完整 init segment (ftyp+moov, 大小:${  view.byteLength  })`);

        // 从 moov 的 avcC box 中提取 SPS/PPS
        const avcC = extractAvcCFromMoov(view);
        if (avcC) {
          const sps = extractSpsFromAvcC(avcC);
          const pps = extractPpsFromAvcC(avcC);
          if (sps && pps) {
            this.codecString = buildCodecString(sps);
            this.initSegment = data;  // 直接使用完整 ftyp+moov 作为 init segment
            console.log('[H264Player] 从 moov 中提取 codec:', this.codecString);
          } else {
            console.warn('[H264Player] moov 存在但无法提取 SPS/PPS');
          }
        } else {
          console.warn('[H264Player] moov 存在但无法找到 avcC box');
        }

        this.initReady = true;
        this.pendingChunks.push(data);

        // 如果 codec 已就绪且 MediaSource 已打开，立即初始化 SourceBuffer
        if (this.codecString && this.mediaSource?.readyState === 'open') {
          this.initSourceBuffer();
        }
      } else {
        // 只有 ftyp，没有 moov，无法获取 codec 信息
        // 缓存 ftyp，等后续 fragment 到来时提取 SPS/PPS
        console.log(`[H264Player] 首个 segment 只有 ftyp (无 moov), 大小:${  view.byteLength  } 缓存等待后续数据`);
        this.pendingChunks.push(data);
        // 不设置 initReady，让后续的 segment 继续走提取逻辑
      }
      return;
    }

    // 如果 segment 太小（< 100 字节），可能只是 header/元数据，等下一个
    if (view.byteLength < 100) {
      console.log(`[H264Player] segment 太小 (${  view.byteLength  } 字节), 可能是 header, 等待下一个 segment`);
      return;
    }

    this.initReady = true;

    // 从第一个 fragment 中提取 SPS/PPS 信息来确定 codec
    const result = extractSpsPpsOnly(data);
    if (result) {
      const { sps, pps } = result;
      this.codecString = buildCodecString(sps);
      const avcC = buildAvcC(sps, pps);
      const { width, height } = parseSpsResolution(sps);
      const init = buildInitManual(avcC, width, height);
      this.initSegment = init.buffer as ArrayBuffer;
      console.log('[H264Player] 生成 init segment, 大小:', init.byteLength, 'codec:', this.codecString);
      console.log('[H264Player] 分辨率:', width, 'x', height);

      // 不篡改原始 fragment，直接 append 原数据
      this.pendingChunks.push(data);
      this.initSourceBuffer();
    } else {
      console.warn('[H264Player] 无法提取 SPS/PPS, 直接 append');
      this.pendingChunks.push(data);
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        this.flushPendingChunks();
      }
    }
  }

  private doAppend(data: ArrayBuffer) {
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        this.sourceBuffer.appendBuffer(data);
      } catch (e) {
        console.warn('[H264Player] appendBuffer 失败, 放入 pending:', e);
        this.pendingChunks.push(data);
      }
    } else {
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
    console.log('[H264Player] 发送 start_stream, project_id:', this.options.projectId, 'token:', token ? (`${token.substring(0, 10)  }...`) : 'null');
    this.socket.emit('start_stream', {
      project_id: this.options.projectId,
      token
    }, (response: any) => {
      // Socket.IO 回调确认（ACK）
      console.log('[H264Player] start_stream ACK:', response);
      if (response?.error) {
        this.options.onError?.(response.error);
      }
    });

    // 超时检测：15 秒内没收到任何视频数据则提示
    setTimeout(() => {
      if (this.attached && !this.initReady) {
        console.error('[H264Player] 超时：start_stream 后 15 秒未收到视频数据');
        console.error('[H264Player] 可能原因: 1) 后端未实现 /ws/camera namespace 的 start_stream 事件 2) token无效被静默拒绝 3) 后端视频源未就绪 4) namespace 或 path 配置不匹配');
        console.error('[H264Player] 当前配置: serverUrl:', globalConfig.serviceBaseURL, 'namespace: /ws/camera, path: /socket.io');
        this.options.onError?.('视频流连接超时：后端未返回视频数据，请检查后端服务');
      }
    }, 15000);
  }

  private flushPendingChunks() {
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
        console.log('[H264Player] append media chunk, 大小:', chunk.byteLength, 'pending剩余:', this.pendingChunks.length);
        this.sourceBuffer.appendBuffer(chunk);

        // 尝试播放视频
        if (this.videoElement && this.videoElement.paused) {
          this.videoElement.play().catch(e => {
            console.warn('[H264Player] play() 失败:', e);
          });
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
    if (this.socket?.connected) {
      this.socket.emit('stop_stream', { project_id: this.options.projectId });
      this.socket.disconnect();
    }
    this.socket = null;
    if (this.videoElement) {
      this.videoElement.src = '';
      this.videoElement = null;
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.pendingChunks = [];
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
      console.log('[H264Player] mdat box, declared size:', boxSize);
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
      console.log('[H264Player] 长度前缀 NAL, type:', nalType, 'len:', nalLen);

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
        console.log('[H264Player] 找到 avcC box, size:', size);
        return view.slice(i, i + size - 8);
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
    // SPS 最小长度：1(nal_header) + 3(profile/constraint/level) + 至少 4 字节
    if (sps.length < 8) {
      console.warn('[H264Player] SPS 太短:', sps.length);
      return { width: 1920, height: 1080 };
    }

    // 从 bit 1*8=8 开始（跳过 1 字节 NAL header）
    let pos = 8;

    const profileIdc = readBits(sps, pos, 8).value; pos += 8;
    pos += 8; // constraint_set_flags (8 bits, 包括 constraint_set0_flag ~ constraint_set5_flag + reserved)
    pos += 8; // level_idc
    // seq_parameter_set_id (ue)
    pos = safeSkipUE(sps, pos);

    // 检查是否是特定 profile（需要额外解析 chroma format 等）
    if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 || profileIdc === 244 ||
        profileIdc === 44 || profileIdc === 83 || profileIdc === 86 || profileIdc === 118 || profileIdc === 128) {
      const chromaResult = safeReadUE(sps, pos);
      pos = chromaResult.pos;
      if (chromaResult.value === 3) {
        pos++;
      } // separate_colour_plane_flag
      pos = safeSkipUE(sps, pos); // bit_depth_luma_minus8
      pos = safeSkipUE(sps, pos); // bit_depth_chroma_minus8
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

    // 边界检查
    if (!isFinite(picWidthResult.value) || !isFinite(picHeightResult.value) ||
        picWidthResult.value < 0 || picHeightResult.value < 0) {
      console.warn('[H264Player] SPS 宽高解析异常, 使用默认分辨率');
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

    console.log(`[H264Player] SPS: picWidthMbs=${  picWidthResult.value 
    } picHeightMbs=${  picHeightResult.value 
    } frameMbsOnly=${  frameMbsOnlyFlag 
    } crop=${  cropLeft  },${  cropTop  },${  cropRight  },${  cropBottom 
    } => coded=${  width  }x${  height  } display=${  displayWidth  }x${  displayHeight}`);

    return { width: Math.round(displayWidth), height: Math.round(displayHeight) };
  } catch (e) {
    console.warn('[H264Player] SPS 解析失败:', e, '使用默认分辨率');
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
    // mvhd
    fbox('mvhd', 0, 0, () => {
      u32(0); u32(0); u32(1000); u32(0);
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
        // mdhd
        fbox('mdhd', 0, 0, () => {
          u32(0); u32(0); u32(1000); u32(0);
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
