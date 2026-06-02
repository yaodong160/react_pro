/**
 * @handle {
 *   "activeMenu": "/annotation",
 *   "keepAlive": true,
 *   "order": 2
 * }
 * 图片采集 - 支持文件上传 & 摄像头捕获
 */

import { useEffectOnActive } from 'keepalive-for-react';

import { globalConfig } from '@/config';
import { fetchDeleteImage, fetchGetImageList, fetchGetProjectList, fetchUploadImages } from '@/services/api';
import { getCurrentProjectId, setCurrentProjectId } from '../store';

const statusTagMap: Record<string, string> = {
  pending: 'default',
  annotated: 'processing',
  reviewed: 'success'
};

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

const ImageCollect = () => {
  const { t } = useTranslation();
  const nav = useNavigate();

  // 当前选中的项目ID
  const [projectId, setProjectId] = useState<number | null>(null);
  // 项目列表（用于下拉选择）
  const [projects, setProjects] = useState<Api.Annotation.Project[]>([]);
  // 图片数据
  const [imageData, setImageData] = useState<{
    records: Api.Annotation.Image[];
    total: number;
    current: number;
    size: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const images = imageData?.records || [];
  const total = imageData?.total || 0;

  // 加载项目列表
  const loadProjects = async () => {
    try {
      const res = await fetchGetProjectList({ current: 1, size: 999 });
      setProjects(res.data?.records || []);
    } catch {
      // ignore
    }
  };

  // 加载图片列表
  const loadImages = async (pid: number) => {
    setLoading(true);
    try {
      const res = await fetchGetImageList({ current: 1, projectId: pid, size: 12, annotateStatus: null });
      setImageData(res.data || { records: [], total: 0, current: 1, size: 12 });
    } catch {
      setImageData(null);
    } finally {
      setLoading(false);
    }
  };

  // 初始化 & keepAlive 激活时：同步本地存储的 projectId
  useEffectOnActive(() => {
    const savedId = getCurrentProjectId();
    if (savedId !== null) {
      setProjectId(savedId);
    }
    loadProjects();
  }, []);

  useEffect(() => {
    if (projectId) {
      loadImages(projectId);
    } else {
      setImageData(null);
    }
  }, [projectId]);

  // 切换项目
  const handleProjectChange = (value: number) => {
    setProjectId(value);
    setCurrentProjectId(value);
  };

  // 文件上传
  const handleUpload = () => {
    if (!projectId) {
      window.$message?.warning(t('page.annotation.image.selectProjectFirst'));
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) {
        return;
      }
      try {
        await fetchUploadImages(projectId, Array.from(files));
        window.$message?.success(t('page.annotation.image.uploadSuccess'));
        loadImages(projectId);
      } catch {
        window.$message?.error(t('common.error'));
      }
    };
    input.click();
  };

  // 摄像头采集 - 跳转到独立页面
  const handleCameraCapture = () => {
    if (!projectId) {
      window.$message?.warning(t('page.annotation.image.selectProjectFirst'));
      return;
    }
    const project = projects.find(p => p.id === projectId);
    // 检查项目是否配置了摄像头（cameraUrl 为摄像头 ISAPI 地址）
    if (!project?.cameraUrl) {
      window.$message?.warning(t('page.annotation.collect.cameraNotConfigured'));
      return;
    }
    setCurrentProjectId(projectId);
    nav(`/annotation/camera/${projectId}`);
  };

  // 删除图片
  const handleDelete = async (id: number) => {
    try {
      await fetchDeleteImage(id);
      window.$message?.success(t('common.deleteSuccess'));
      if (projectId) {
        loadImages(projectId);
      }
    } catch {
      window.$message?.error(t('common.error'));
    }
  };

  // 当前选中项目名
  const currentProjectName = projects.find(p => p.id === projectId)?.projectName || '';

  return (
    <div className="h-full flex-col gap-12px overflow-auto p-16px">
      <ACard
        extra={(
          <AFlex gap={8}>
            <AButton
              type="primary"
              onClick={() => {
                if (projectId) {
                  setCurrentProjectId(projectId);
                  nav('/annotation/annotate');
                }
              }}
            >
              {t('page.annotation.annotate.title')}
            </AButton>
            <AButton
              ghost
              type="primary"
              onClick={handleUpload}
            >
              {t('page.annotation.image.upload')}
            </AButton>
            <AButton
              onClick={handleCameraCapture}
            >
              {t('page.annotation.collect.cameraCapture')}
            </AButton>
          </AFlex>
        )}
        title={t('page.annotation.collect.title')}
        variant="borderless"
      >
        {/* 项目选择 */}
        <div className="mb-16px flex items-center gap-12px">
          <span className="text-text-secondary text-14px">{t('page.annotation.collect.selectProject')}:</span>
          <ASelect
            allowClear
            className="w-240px"
            notFoundContent={t('page.annotation.collect.noProject')}
            placeholder={t('page.annotation.collect.selectProjectPlaceholder')}
            showSearch
            value={projectId}
            filterOption={(input: string, option: any) =>
              option?.label?.toLowerCase().includes(input.toLowerCase())
            }
            options={projects.map(p => ({
              label: p.projectName,
              value: p.id
            }))}
            onChange={handleProjectChange}
          />
          {currentProjectName && (
            <ATag color="blue">{currentProjectName}</ATag>
          )}
        </div>

        {/* 图片列表 */}
        {!projectId ? (
          <div className="flex-center py-64px">
            <AResult
              status="info"
              subTitle={t('page.annotation.image.selectProjectFirst')}
            />
          </div>
        ) : loading ? (
          <div className="flex-center py-64px">
            <ASpin size="large" />
          </div>
        ) : images.length === 0 ? (
          <div className="flex-center py-64px">
            <AResult
              status="info"
              subTitle={t('page.annotation.annotate.noImages')}
            />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-16px lg:grid-cols-4 xl:grid-cols-6">
            {images.map((img: Api.Annotation.Image) => (
              <ACard
                key={img.id}
                actions={[
                  <APopconfirm
                    key="delete"
                    cancelText={t('common.cancel')}
                    okText={t('common.confirm')}
                    title={t('common.confirmDelete')}
                    onConfirm={() => handleDelete(img.id)}
                  >
                    <AButton
                      danger
                      size="small"
                      type="text"
                    >
                      {t('common.delete')}
                    </AButton>
                  </APopconfirm>
                ]}
                className="overflow-hidden"
                hoverable
                size="small"
              >
                <div className="relative">
                  <img
                    alt={img.imageName}
                    className="aspect-4/3 w-full object-cover"
                    src={resolveImageUrl(img.imageUrl)}
                  />
                  <ATag
                    className="absolute right-4px top-4px"
                    color={statusTagMap[img.annotateStatus]}
                  >
                    {t(`page.annotation.image.${img.annotateStatus}`)}
                  </ATag>
                </div>
                <div className="p-8px text-center text-12px">
                  <div className="truncate">{img.imageName}</div>
                  {img.annotator && (
                    <div className="text-text-tertiary mt-4px">
                      {img.annotator} · {img.annotateTime}
                    </div>
                  )}
                </div>
              </ACard>
            ))}
          </div>
        )}

        {total > 12 && (
          <div className="text-text-tertiary mt-16px flex-center text-14px">
            {t('common.total')}: {total}
          </div>
        )}
      </ACard>
    </div>
  );
};

export default ImageCollect;
