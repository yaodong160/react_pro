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
  const { projectId: paramProjectId } = useParams<{ projectId: string }>();

  const projectId = Number(paramProjectId);

  // 连通状态
  const [connected, setConnected] = useState<boolean | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [checking, setChecking] = useState(false);
  const [connectError, setConnectError] = useState('');

  // 云台控制
  const [ptzActive, setPtzActive] = useState<string | null>(null);
  const ptzTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setConnected(true);
      setDeviceName(res.data?.deviceName || '');
      // 连通后加载分辨率
      loadResolutions();
    } catch (e: any) {
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

  // 清理云台定时器
  useEffect(() => {
    return () => {
      if (ptzTimerRef.current) {
        clearInterval(ptzTimerRef.current);
      }
    };
  }, []);

  // 发送云台指令
  const sendPtz = async (action: string, isContinuous = false) => {
    const params: Api.Camera.PtzParams = {
      action: action as Api.Camera.PtzParams['action'],
      speed: 5
    };
    if (!isContinuous && (action === 'zoomIn' || action === 'zoomOut')) {
      params.duration = 500;
    }
    try {
      await fetchCameraPtz(projectId, params);
    } catch {
      // ignore
    }
  };

  // 云台按钮按下（长按连续移动）
  const handlePtzDown = (action: string) => {
    setPtzActive(action);
    sendPtz(action, true);
    // 持续发送，每 200ms 一次
    ptzTimerRef.current = setInterval(() => {
      sendPtz(action, true);
    }, 200);
  };

  // 云台按钮松开
  const handlePtzUp = () => {
    setPtzActive(null);
    if (ptzTimerRef.current) {
      clearInterval(ptzTimerRef.current);
      ptzTimerRef.current = null;
    }
    sendPtz('stop');
  };

  // 变焦点击
  const handleZoom = (action: 'zoomIn' | 'zoomOut') => {
    sendPtz(action);
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
        setCaptures(prev => [res.data!, ...prev]);
        window.$message?.success(t('page.annotation.camera.captureSuccess'));
      }
    } catch {
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
    setConnected(null);
    setDeviceName('');
    setResolutions([]);
    setCurrentResolution(null);
    setCaptures([]);
    if (ptzTimerRef.current) {
      clearInterval(ptzTimerRef.current);
      ptzTimerRef.current = null;
    }
  };

  // 返回图片采集页
  const handleBack = () => {
    nav('/annotation/collect');
  };

  // MJPEG 预览地址
  const previewUrl = `/api/camera/preview/${projectId}`;

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
                <img
                  alt="Camera Preview"
                  className="max-h-full max-w-full object-contain"
                  src={previewUrl}
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
              <div className="flex-col items-center gap-4px">
                <AButton
                  disabled={!connected}
                  className={ptzActive === 'up' ? 'colorPrimary' : ''}
                  icon={<IconIcBaselineKeyboardArrowUp />}
                  size="large"
                  type={ptzActive === 'up' ? 'primary' : 'default'}
                  onMouseDown={() => handlePtzDown('up')}
                  onMouseLeave={handlePtzUp}
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
                    onMouseLeave={handlePtzUp}
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
                    onMouseLeave={handlePtzUp}
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
                  onMouseLeave={handlePtzUp}
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

        {/* 底部采集记录 */}
        {captures.length > 0 && (
          <div className="border-t border-[var(--ant-color-border-secondary)] px-16px py-8px">
            <div className="text-text-secondary mb-8px text-12px">
              {t('page.annotation.camera.captureRecords')} · {t('common.total')}: {captures.length}
            </div>
            <div className="flex gap-8px overflow-x-auto">
              {captures.map((cap, idx) => (
                <div
                  key={cap.imageId || idx}
                  className="w-120px shrink-0 overflow-hidden border border-[var(--ant-color-border-secondary)] rounded-4px"
                >
                  <img
                    alt={cap.filename}
                    className="aspect-4/3 w-full object-cover"
                    src={resolveImageUrl(cap.thumbnailUrl || cap.fileUrl)}
                  />
                  <div className="text-text-tertiary truncate p-4px text-center text-10px">
                    {cap.filename}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default CameraCapture;
