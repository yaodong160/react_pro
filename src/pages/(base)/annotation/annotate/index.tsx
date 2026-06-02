/**
 * @handle {
 *   "activeMenu": "/annotation",
 *   "keepAlive": true,
 *   "order": 3
 * }
 * 标注工作台 - 选择项目后进行图片标注
 */

import ReactImageAnnotate from '@amnstak/react-image-annotate';
import { useEffectOnActive } from 'keepalive-for-react';

import { globalConfig } from '@/config';
import { fetchGetImageList, fetchGetProjectDetail, fetchGetProjectList, fetchGetProjectResults, fetchSaveImageResults } from '@/services/api';
import { getCurrentProjectId, setCurrentProjectId } from '../store';

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

const AnnotateWorkspace = () => {
  const { t } = useTranslation();

  // 当前选中的项目ID
  const [projectId, setProjectId] = useState<number | null>(null);
  // 项目列表（用于下拉选择）
  const [projects, setProjects] = useState<Api.Annotation.Project[]>([]);
  // 项目详情 & 图片数据
  const [project, setProject] = useState<Api.Annotation.Project | null>(null);
  const [images, setImages] = useState<Api.Annotation.Image[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // 当前标注的图片索引
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  // 已保存的标注结果，key 为 imageId
  const [savedResults, setSavedResults] = useState<Map<number, Api.Annotation.RegionData[]>>(new Map());

  // 加载项目列表
  const loadProjects = async () => {
    try {
      const res = await fetchGetProjectList({ current: 1, size: 999 });
      setProjects(res.data?.records || []);
    } catch {
      // ignore
    }
  };

  // 加载项目详情和图片
  const loadData = async (pid: number) => {
    setLoading(true);
    try {
      const [projectRes, imagesRes] = await Promise.all([
        fetchGetProjectDetail(pid),
        fetchGetImageList({ current: 1, projectId: pid, size: 999, annotateStatus: null })
      ]);
      setProject(projectRes.data!);
      setImages(imagesRes.data?.records || []);
    } catch {
      setProject(null);
      setImages([]);
    } finally {
      setLoading(false);
    }
  };

  // 加载已保存的标注结果（独立请求，失败不影响图片加载）
  const loadResults = async (pid: number) => {
    try {
      const res = await fetchGetProjectResults(pid);
      const resultsMap = new Map<number, Api.Annotation.RegionData[]>();
      const resultList = res.data || [];
      for (const item of resultList) {
        resultsMap.set(item.imageId, item.regions || []);
      }
      setSavedResults(resultsMap);
    } catch {
      // 接口不存在或失败时，regions 为空，不影响标注功能
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
      loadData(projectId);
      loadResults(projectId);
    } else {
      setProject(null);
      setImages([]);
      setSavedResults(new Map());
    }
  }, [projectId]);

  // 切换项目
  const handleProjectChange = (value: number) => {
    setProjectId(value);
    setCurrentProjectId(value);
  };

  // 统计进度
  const annotatedCount = images.filter(img => img.annotateStatus !== 'pending').length;
  const totalCount = images.length;

  /** 将后端 RegionData 转换为 react-image-annotate 的 Region 格式 */
  const convertRegionFromBackend = (rd: Api.Annotation.RegionData): any => {
    const base = {
      cls: rd.cls || '',
      tags: rd.tags || [],
      comment: rd.comment || ''
    };
    const pts = (rd.points || []).filter((p: number[]) => Array.isArray(p) && p.length >= 2);

    let frontendType: string;
    if (rd.type === 'create-box') {
      frontendType = 'box';
    } else if (rd.type === 'create-polygon') {
      frontendType = 'polygon';
    } else if (rd.type === 'create-point') {
      frontendType = 'point';
    } else {
      frontendType = 'box';
    }

    if (pts.length === 0) {
      return { ...base, type: frontendType };
    }

    if (frontendType === 'box') {
      const xs = pts.map((p: number[]) => p[0]);
      const ys = pts.map((p: number[]) => p[1]);
      return { ...base, type: 'box', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }

    if (frontendType === 'point') {
      return { ...base, type: 'point', x: pts[0][0], y: pts[0][1] };
    }

    return { ...base, type: 'polygon', points: pts };
  };

  /** 将 react-image-annotate 的 Region 转换为后端 RegionData 格式 */
  const convertRegionToBackend = (r: any): Api.Annotation.RegionData => {
    const base = {
      cls: r.cls || '',
      tags: r.tags || [],
      comment: r.comment || ''
    };
    if (r.type === 'box') {
      const { x = 0, y = 0, w = 0, h = 0 } = r;
      return { ...base, type: 'create-box', points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
    }
    if (r.type === 'point') {
      return { ...base, type: 'create-point', points: [[r.x ?? 0, r.y ?? 0]] };
    }
    return { ...base, type: 'create-polygon', points: r.points || [] };
  };

  // 转换数据为 react-image-annotate 格式
  const annotateImages = images.map(img => ({
    src: resolveImageUrl(img.imageUrl),
    name: img.imageName,
    regions: (savedResults.get(img.id) || []).map(rd => convertRegionFromBackend(rd))
  }));

  const handleSave = async (state: any) => {
    if (!project) {
      return;
    }
    const imgIndex = state.selectedImage;
    const image = images[imgIndex];
    if (!image) {
      return;
    }
    setSaving(true);
    try {
      const currentImage = state.images?.[imgIndex];
      if (currentImage?.regions?.length > 0) {
        const backendRegions = currentImage.regions.map((r: any) => convertRegionToBackend(r));
        await fetchSaveImageResults(project.id, image.id, backendRegions);
      }
      window.$message?.success(t('page.annotation.annotate.saveSuccess'));
    } catch {
      window.$message?.error(t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  // 翻页处理：库内部点击 Next/Prev 后调用此回调
  // 用 state.selectedImage（库内部当前索引）做边界判断，确保准确性
  const handleNextImage = async (state: any) => {
    await handleSave(state);
    const currentIdx = state.selectedImage;
    if (currentIdx < images.length - 1) {
      setCurrentImageIndex(currentIdx + 1);
    }
  };

  const handlePrevImage = async (state: any) => {
    await handleSave(state);
    const currentIdx = state.selectedImage;
    if (currentIdx > 0) {
      setCurrentImageIndex(currentIdx - 1);
    }
  };

  // 当前选中项目名
  const currentProjectName = projects.find(p => p.id === projectId)?.projectName || '';

  return (
    <div className="h-full flex-col overflow-hidden">
      {/* 顶部操作栏 */}
      <div className="flex items-center gap-16px border-b border-[var(--ant-color-border-secondary)] px-16px py-8px">
        {/* 项目选择 */}
        <span className="text-text-secondary text-14px">{t('page.annotation.collect.selectProject')}:</span>
        <ASelect
          allowClear
          className="w-200px"
          notFoundContent={t('page.annotation.collect.noProject')}
          placeholder={t('page.annotation.collect.selectProjectPlaceholder')}
          showSearch
          size="small"
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
        {project && (
          <>
            <ADivider type="vertical" />
            <span className="text-text-secondary text-14px">
              {t('page.annotation.annotate.progress')}: {annotatedCount}/{totalCount}
              {' '}
              ({totalCount > 0 ? Math.round((annotatedCount / totalCount) * 100) : 0}%)
            </span>
            <div className="ml-auto flex items-center gap-8px">
              <span className="text-text-tertiary text-12px">
                {t('page.annotation.project.tools')}: {project.tools?.join(', ')}
              </span>
              {saving && <ASpin size="small" />}
            </div>
          </>
        )}
      </div>

      {/* 标注组件区域 */}
      <div className="flex-1 overflow-hidden">
        {!projectId ? (
          <div className="h-full flex-center">
            <AResult
              status="info"
              subTitle={t('page.annotation.image.selectProjectFirst')}
              title={t('page.annotation.annotate.title')}
            />
          </div>
        ) : loading ? (
          <div className="h-full flex-center">
            <ASpin size="large" />
          </div>
        ) : images.length === 0 ? (
          <div className="h-full flex-center">
            <AResult
              status="warning"
              subTitle={t('page.annotation.annotate.noImages')}
              title={t('page.annotation.annotate.title')}
            />
          </div>
        ) : project && annotateImages.length > 0 ? (
          <ReactImageAnnotate
            key={`annotator-${project.id}`}
            allowComments={project.enableComment}
            enabledTools={project.tools || ['create-box']}
            images={annotateImages}
            selectedImage={currentImageIndex}
            regionClsList={project.classes?.map(c => c.name) || []}
            regionTagList={project.tags || []}
            taskDescription={project.description || t('page.annotation.annotate.taskDescription')}
            onExit={handleSave}
            onNextImage={handleNextImage}
            onPrevImage={handlePrevImage}
          />
        ) : (
          <div className="h-full flex-center">
            <ASpin size="large" />
          </div>
        )}
      </div>
    </div>
  );
};

export default AnnotateWorkspace;
