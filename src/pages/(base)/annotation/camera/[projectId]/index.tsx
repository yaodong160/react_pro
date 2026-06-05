/**
 * @handle {
 *   "activeMenu": "/annotation",
 *   "keepAlive": false,
 *   "order": 4,
 *   "hideInMenu": true,
 *   "title": "摄像头采集"
 * }
 */

import { fetchCameraCapture, fetchCameraCheck, fetchCameraPtz, fetchCameraResolutions, fetchSetCameraResolution } from '@/services/api';
import { globalConfig } from '@/config';
import { H264Player } from '@/utils/h264-player';

/** 将后端返回的相对路径拼接为完整图片URL */
function resolveImageUrl(url: string) {
  if (!url) {
    return url;
  }
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('blob:')) {
    return url;
  }
  return `${globalConfig.imageBaseURL}${url.startsWith('/') ? '' : '/'}${url}`;
}

const CameraCapture = () => {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { projectid } = useParams<{ projectid: string }>();
  const projectId = Number(projectid);

  // 连通状态
  const [connected, setConnected] = useState<boolean | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [checking, setChecking] = useState(false);
  const [connectError, setConnectError] = useState('');

  // 云台控制
  const [ptzActive, setPtzActive] = useState<string | null>(null);
  const ptzActiveRef = useRef<string | null>(null);

  // 分辨率
  const [resolutions, setResolutions] = useState<Api.Camera.Resolution[]>([]);
  const [currentResolution, setCurrentResolution] = useState<Api.Camera.Resolution | null>(null);

  // 截帧记录
  const [captures, setCaptures] = useState<Api.Camera.CaptureResult[]>([]);
  const [capturing, setCapturing] = useState(false);

  // 检查连通性
  const checkConnection = async () => {
    setChecking(true);
    setConnected(null);
    setConnectError('');
    try {
      const res = await fetchCameraCheck(projectId);
      const isConnected = res.data?.connected ?? false;
      setConnected(isConnected);
      setDeviceName(res.data?.deviceName || '');
      if (isConnected) {
        loadResolutions();
        setShouldStartPlayer(true);
      } else {
        setConnectError(t('page.annotation.camera.connectFailed'));
      }
    } catch (e: any) {
      console.error('[Camera] checkConnection 异常:', e);
      setConnected(false);
      setConnectError(e?.message || t('common.error'));
    } finally {
      setChecking(false);
    }
  };

  // 加载分辨率
  const loadResolutions = async () => {
    try {
      const res = await fetchCameraResolutions(projectId);
      if (res.data) {
        setResolutions(res.data.resolutions || []);
        setCurrentResolution(res.data.current || null);
      }
    } catch {
      // 分辨率接口可选
    }
  };

  // 发送云台指令
  const sendPtz = (action: string, params?: Partial<Api.Camera.PtzParams>) => {
    fetchCameraPtz(projectId, { action: action as Api.Camera.PtzParams['action'], speed: 5, ...params })
      .catch((e: any) => {
        console.warn('[PTZ] 请求失败:', action, e?.message);
      });
  };

  // 方向键按下：duration=0，后端持续移动不阻塞
  const handlePtzDown = (action: string) => {
    if (ptzActiveRef.current === action) {
      return;
    }
    ptzActiveRef.current = action;
    setPtzActive(action);
    sendPtz(action, { duration: 0 });
  };

  // 方向键松开：发 stop
  const handlePtzUp = () => {
    if (!ptzActiveRef.current) {
      return;
    }
    ptzActiveRef.current = null;
    setPtzActive(null);
    sendPtz('stop');
  };

  // 变焦单击：duration=500，后端自动停止
  const handleZoom = (action: 'zoomIn' | 'zoomOut') => {
    sendPtz(action, { duration: 500 });
  };

  // 截取当前帧
  const handleCapture = async () => {
    if (!connected || capturing) {
      return;
    }
    setCapturing(true);
    try {
      const res = await fetchCameraCapture(projectId);
      if (res.data) {
        const captureData = res.data;
        setCaptures(prev => [captureData, ...prev]);
        window.$message?.success(t('page.annotation.camera.captureSuccess'));
      } else {
        console.warn('[Camera] capture 返回空数据, error:', res.error);
        window.$message?.error(t('common.error'));
      }
    } catch (e: any) {
      console.error('[Camera] capture 异常:', e);
      window.$message?.error(t('common.error'));
    } finally {
      setCapturing(false);
    }
  };

  // 切换分辨率
  const handleResolutionChange = async (value: string) => {
    const [w, h] = value.split('x').map(Number);
    try {
      await fetchSetCameraResolution(projectId, { width: w, height: h });
      setCurrentResolution({ width: w, height: h });
    } catch {
      // ignore
    }
  };

  // 关闭连接
  const handleDisconnect = () => {
    stopH264Player();
    setConnected(null);
    setDeviceName('');
    setResolutions([]);
    setCurrentResolution(null);
    setCaptures([]);
    ptzActiveRef.current = null;
  };

  // 返回图片采集页
  const handleBack = () => {
    nav('/annotation/collect');
  };

  // H.264 视频播放
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<H264Player | null>(null);
  // 用 state 触发启动，确保在 React 渲染完成（video 元素已挂载）后才执行
  const [shouldStartPlayer, setShouldStartPlayer] = useState(false);

  // 启动 H.264 播放（与 connected 状态解耦，避免云台操作导致的短暂断开销毁播放器）
  const startH264Player = useCallback(() => {
    const video = videoRef.current;
    if (!video || playerRef.current) {
      return;
    }

    const player = new H264Player({
      projectId,
      onError: (msg) => {
        window.$message?.error(msg);
        setConnectError(msg);
      },
      onStatusChange: (status) => {
        if (status === 'connected') {
          setConnected(true);
        }
      }
    });

    player.attach(video);
    playerRef.current = player;
  }, [projectId]);

  // 停止 H.264 播放
  const stopH264Player = useCallback(() => {
    playerRef.current?.destroy();
    playerRef.current = null;
    setShouldStartPlayer(false);
  }, []);

  // 监听 shouldStartPlayer 状态，在下一帧启动播放器（确保 DOM 就绪）
  useEffect(() => {
    if (!shouldStartPlayer) {
      return;
    }
    // 使用 requestAnimationFrame 确保 video 元素已挂载
    const raf = requestAnimationFrame(() => {
      startH264Player();
    });
    return () => cancelAnimationFrame(raf);
  }, [shouldStartPlayer, startH264Player]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      stopH264Player();
    };
  }, [stopH264Player]);

  return (
    <div className="h-full flex-col overflow-hidden">
      {/* 顶部导航栏：返回 + 标题 + 连接状态 + 连接/关闭按钮 */}
      <div className="flex items-center gap-16px border-b border-[var(--ant-color-border-secondary)] px-16px py-8px">
        <AButton
          icon={<IconIcBaselineArrowBack />}
          size="small"
          type="text"
          onClick={handleBack}
        >
          {t('page.annotation.camera.backToCollect')}
        </AButton>
        <ADivider type="vertical" />
        <span className="text-16px font-medium">{t('page.annotation.camera.title')}</span>
        {deviceName && (
          <ATag color="blue">{deviceName}</ATag>
        )}
        {/* 连接状态 + 连接/关闭连接 */}
        <div className="ml-auto flex items-center gap-8px">
          {checking ? (
            <>
              <ASpin size="small" />
              <span className="text-text-tertiary text-12px">{t('page.annotation.camera.checking')}</span>
            </>
          ) : connected ? (
            <ATag color="success">{t('page.annotation.camera.connected')}</ATag>
          ) : (
            <ATag color="error">{t('page.annotation.camera.disconnected')}</ATag>
          )}
          <AButton
            loading={checking}
            size="small"
            type={connected ? 'default' : 'primary'}
            onClick={connected ? handleDisconnect : checkConnection}
          >
            {connected ? t('page.annotation.camera.disconnect') : t('page.annotation.camera.connectTest')}
          </AButton>
        </div>
      </div>

      {/* 主内容区：采集页面始终可见 */}
      <div className="flex-col flex-1 overflow-hidden">
        {connected === false && connectError && (
          <div className="border-b border-[var(--ant-color-error-border)] bg-[var(--ant-color-error-bg)] px-16px py-8px text-14px text-[var(--ant-color-error)]">
            {connectError}
          </div>
        )}
        <div className="flex flex-1 gap-16px overflow-hidden p-16px">
          {/* 左侧：实时预览 */}
          <div className="flex-col flex-1 overflow-hidden border border-[var(--ant-color-border-secondary)] rounded-8px bg-black">
            <div className="flex-center flex-1 overflow-hidden">
              {connected ? (
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="text-text-secondary text-center text-14px">
                  {checking ? (
                    <ASpin size="large" />
                  ) : (
                    <div>
                      <div className="mb-8px text-48px opacity-30">📷</div>
                      <div>{t('page.annotation.camera.clickToConnect')}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 右侧：控制面板 */}
          <div className="w-200px flex-col shrink-0 gap-16px">
            {/* 云台控制 */}
            <ACard
              size="small"
              title={t('page.annotation.camera.ptzControl')}
            >
              <div
                className="flex-col items-center gap-4px"
                onMouseLeave={handlePtzUp}
              >
                <AButton
                  disabled={!connected}
                  className={ptzActive === 'up' ? 'colorPrimary' : ''}
                  icon={<IconIcBaselineKeyboardArrowUp />}
                  size="large"
                  type={ptzActive === 'up' ? 'primary' : 'default'}
                  onMouseDown={() => handlePtzDown('up')}
                  onMouseUp={handlePtzUp}
                />
                <div className="flex gap-4px">
                  <AButton
                    disabled={!connected}
                    className={ptzActive === 'left' ? 'colorPrimary' : ''}
                    icon={<IconIcBaselineKeyboardArrowLeft />}
                    size="large"
                    type={ptzActive === 'left' ? 'primary' : 'default'}
                    onMouseDown={() => handlePtzDown('left')}
                    onMouseUp={handlePtzUp}
                  />
                  <AButton
                    disabled
                    icon={<IconIcBaselineRadioButtonUnchecked />}
                    size="large"
                  />
                  <AButton
                    disabled={!connected}
                    className={ptzActive === 'right' ? 'colorPrimary' : ''}
                    icon={<IconIcBaselineKeyboardArrowRight />}
                    size="large"
                    type={ptzActive === 'right' ? 'primary' : 'default'}
                    onMouseDown={() => handlePtzDown('right')}
                    onMouseUp={handlePtzUp}
                  />
                </div>
                <AButton
                  disabled={!connected}
                  className={ptzActive === 'down' ? 'colorPrimary' : ''}
                  icon={<IconIcBaselineKeyboardArrowDown />}
                  size="large"
                  type={ptzActive === 'down' ? 'primary' : 'default'}
                  onMouseDown={() => handlePtzDown('down')}
                  onMouseUp={handlePtzUp}
                />
              </div>
            </ACard>

            {/* 变焦控制 */}
            <ACard
              size="small"
              title={t('page.annotation.camera.zoom')}
            >
              <AFlex
                gap={8}
                vertical
              >
                <AButton
                  block
                  disabled={!connected}
                  icon={<IconIcBaselineAdd />}
                  onClick={() => handleZoom('zoomIn')}
                >
                  {t('page.annotation.camera.zoomIn')}
                </AButton>
                <AButton
                  block
                  disabled={!connected}
                  icon={<IconIcBaselineRemove />}
                  onClick={() => handleZoom('zoomOut')}
                >
                  {t('page.annotation.camera.zoomOut')}
                </AButton>
              </AFlex>
            </ACard>

            {/* 分辨率 */}
            {resolutions.length > 0 && (
              <ACard
                size="small"
                title={t('page.annotation.camera.resolution')}
              >
                <ASelect
                  className="w-full"
                  disabled={!connected}
                  value={currentResolution ? `${currentResolution.width}x${currentResolution.height}` : undefined}
                  options={resolutions.map(r => ({
                    label: `${r.width}×${r.height}`,
                    value: `${r.width}x${r.height}`
                  }))}
                  onChange={handleResolutionChange}
                />
              </ACard>
            )}

            {/* 截帧按钮 */}
            <AButton
              block
              disabled={!connected}
              loading={capturing}
              size="large"
              type="primary"
              onClick={handleCapture}
            >
              {t('page.annotation.camera.capture')}
            </AButton>
          </div>
        </div>

        {/* 底部采集记录 — 最大高度占剩余空间 1/8 */}
        {captures.length > 0 && (
          <div className="flex-col border-t border-[var(--ant-color-border-secondary)] px-16px py-8px" style={{ maxHeight: '12.5%', minHeight: '80px' }}>
            <div className="text-text-secondary mb-8px shrink-0 text-12px">
              {t('page.annotation.camera.captureRecords')} · {t('common.total')}: {captures.length}
            </div>
            <div className="flex flex-1 items-stretch gap-8px overflow-x-auto pb-4px" style={{ minHeight: 0 }}>
              {captures.map((cap, idx) => {
                const rawUrl = cap.thumbnail_url || cap.file_url;
                const imgSrc = resolveImageUrl(rawUrl);
                return (
                  <div
                    key={cap.id || idx}
                    className="flex-col shrink-0 overflow-hidden border border-[var(--ant-color-border-secondary)] rounded-4px"
                    style={{ width: 'auto', maxWidth: '120px' }}
                  >
                    <div className="relative flex-shrink-0 overflow-hidden bg-gray-100" style={{ aspectRatio: '4/3', height: '100%', width: 'auto' }}>
                      <img
                        alt={cap.filename || `capture-${idx}`}
                        className="absolute inset-0 h-full w-full object-cover"
                        src={imgSrc}
                        onError={(e) => {
                          const el = e.target as HTMLImageElement;
                          el.style.display = 'none';
                        }}
                      />
                      <div className="text-text-tertiary pointer-events-none absolute inset-0 flex items-center justify-center text-10px">
                        {cap.filename || `#${cap.id}`}
                      </div>
                    </div>
                    <div className="text-text-tertiary truncate p-2px text-center text-10px leading-tight">
                      {cap.filename || `#${cap.id}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CameraCapture;
