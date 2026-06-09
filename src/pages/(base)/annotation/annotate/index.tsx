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

/** 分类颜色调色板（与 react-image-annotate 库内置调色板一致） */
const CLASS_COLORS = ['#f44336', '#2196f3', '#4caf50', '#ef6c00', '#795548', '#689f38', '#e91e63', '#9c27b0', '#3f51b5', '#009688', '#cddc39', '#607d8b'];

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
      // 先并行获取所有数据，再一次性设置状态，避免 images 先渲染而 regions 尚未加载导致回显丢失
      (async () => {
        setLoading(true);
        try {
          const [projectRes, imagesRes, resultsRes] = await Promise.all([
            fetchGetProjectDetail(projectId),
            fetchGetImageList({ current: 1, projectId, size: 999, annotateStatus: null }),
            fetchGetProjectResults(projectId).catch(() => ({ data: [] as Api.Annotation.ImageResult[] }))
          ]);
          setProject(projectRes.data!);
          setImages(imagesRes.data?.records || []);
          const resultsMap = new Map<number, Api.Annotation.RegionData[]>();
          const resultList = resultsRes.data || [];
          for (const item of resultList) {
            resultsMap.set(item.imageId, item.regions || []);
          }
          // DEBUG: 打印后端返回的原始数据
          console.log('[Annotate] savedResults from backend, count:', resultsMap.size, 'entries:');
          resultsMap.forEach((regions, imageId) => {
            console.log(`  imageId=${imageId}, regions.length=${regions.length}`);
            regions.forEach((rd, i) => {
              console.log(`    [${i}] raw region:`, JSON.stringify(rd));
            });
          });
          setSavedResults(resultsMap);
        } catch {
          setProject(null);
          setImages([]);
          setSavedResults(new Map());
        } finally {
          setLoading(false);
        }
      })();
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

  /** 根据 cls 名称和 regionClsList 查找对应颜色 */
  const getClsColor = (cls: string) => {
    if (!cls || !project?.classes) return '#ff0000';
    const idx = project.classes.findIndex(c => c.name === cls);
    if (idx >= 0) return CLASS_COLORS[idx % CLASS_COLORS.length];
    return '#ff0000';
  };

  /** 将后端 RegionData 转换为 react-image-annotate 的 Region 格式 */
  const convertRegionFromBackend = (rd: Api.Annotation.RegionData, index: number): any => {
    // id 和 color 是 BaseRegion 的必填字段，缺少会导致标注框无法渲染
    // editingLabels: true 确保历史区域能渲染 RegionEditLabel（三圆点徽章）
    const base = {
      id: rd.id ?? `history-${index}`,
      color: rd.color || getClsColor(rd.cls || ''),
      cls: rd.cls || '',
      tags: rd.tags || [],
      comment: rd.comment || '',
      editingLabels: true
    };
    const pts = (rd.points || []).filter((p: number[]) => Array.isArray(p) && p.length >= 2);

    let frontendType: string;
    // 兼容后端返回的两种 type 格式：create-box/box 等
    if (rd.type === 'create-box' || rd.type === 'box') {
      frontendType = 'box';
    } else if (rd.type === 'create-polygon' || rd.type === 'polygon') {
      frontendType = 'polygon';
    } else if (rd.type === 'create-point' || rd.type === 'point') {
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
      comment: r.comment || '',
      color: r.color || getClsColor(r.cls || '')
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
  const annotateImages = images.map(img => {
    const backendRegions = savedResults.get(img.id) || [];
    const frontendRegions = backendRegions.map((rd, idx) => convertRegionFromBackend(rd, idx));
    return {
      src: resolveImageUrl(img.imageUrl),
      name: img.imageName,
      regions: frontendRegions
    };
  });
  console.log('[Annotate] annotateImages built:', annotateImages.length, 'total regions:', annotateImages.reduce((sum, img) => sum + img.regions.length, 0), 'savedResults size:', savedResults.size, 'savedResults keys:', [...savedResults.keys()]);
  annotateImages.forEach((img, i) => {
    console.log(`  annotateImages[${i}] name=${img.name} regions.length=${img.regions.length}`);
    img.regions.forEach((r: any, j: number) => {
      console.log(`    [${j}] region:`, JSON.stringify({ id: r.id, cls: r.cls, type: r.type, color: r.color, editingLabels: r.editingLabels }));
    });
  });
  // DEBUG: 检查 showTags localStorage 值
  try {
    const showTagsVal = window.localStorage['__REACT_IMAGE_ANNOTATE_showTags'];
    console.log('[Annotate] localStorage showTags:', showTagsVal, 'parsed:', JSON.parse(showTagsVal || 'null'));
  } catch {
    console.log('[Annotate] localStorage showTags: not found or parse error');
  }

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
        // 【坐标测试】打印库 state 中的原始 region 数据
        console.group('[CoordTest] handleSave - state regions:');
        currentImage.regions.forEach((r: any, i: number) => {
          console.log(`  region[${i}] type=${r.type} x=${r.x} y=${r.y} w=${r.w} h=${r.h} points=${JSON.stringify(r.points)}`);
        });
        const backendRegions = currentImage.regions.map((r: any) => convertRegionToBackend(r));
        // 【坐标测试】打印转换后的后端数据
        backendRegions.forEach((rd: Api.Annotation.RegionData, i: number) => {
          console.log(`  backendRegion[${i}] type=${rd.type} points=${JSON.stringify(rd.points)}`);
        });
        console.groupEnd();
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

  /** 标签/注释选项用到的颜色调色板 */
  const TAG_COMMENT_COLORS = ['#f44336', '#2196f3', '#4caf50', '#ef6c00', '#9c27b0', '#009688', '#e91e63', '#795548', '#3f51b5', '#689f38', '#cddc39', '#607d8b'];

  /** 构建带颜色圆点的选项（圆点宽度固定对齐） */
  const buildDotOption = (label: string, value: string, color: string) => ({
    label: (
      <span className="flex items-center gap-6px">
        <span style={{ display: 'inline-block', width: 8, minWidth: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />
        {label}
      </span>
    ),
    value
  });

  /**
   * 控制面板展开状态的 Set，key 为 region.id
   * 用 ref 而非 state，因为 RegionEditLabel 内部需要读取，但不需要触发外层重渲染
   */
  const editingRegionIdsRef = useRef<Set<string>>(new Set());

  /** 存储每个 region 的拖动偏移 */
  const dragOffsetsRef = useRef<Map<string, { dx: number; dy: number }>>(new Map());

  /** 自定义 Region 编辑器 */
  const RegionEditLabel = ({ region, onChange, onOpen, allowedClasses, allowedTags, tagSingleSelection, allowComments }: any) => {
    const regionId: string = region?.id ?? '';

    // 用 state 触发重渲染（因为 ref 修改不会触发渲染）
    const [, forceUpdate] = useState(0);

    // 确认组件挂载 & region 数据
    const triggerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      console.log('[RegionEditLabel] mounted, regionId:', regionId, 'region:', JSON.stringify({ cls: region.cls, tags: region.tags, comment: region.comment, editingLabels: region.editingLabels }));
      // 新增的 region（无 cls、无 tags、无 comment）自动展开面板
      const isNewRegion = !region.cls && (!region.tags || region.tags.length === 0) && !region.comment;
      if (isNewRegion) {
        editingRegionIdsRef.current.clear();
        editingRegionIdsRef.current.add(regionId);
        forceUpdate(n => n + 1);
      }
    }, []);

    // 分类选项
    const classOptions = (allowedClasses || []).map((c: any) => {
      const label = typeof c === 'string' ? c : (c.label || c.id);
      const value = typeof c === 'string' ? c : c.id;
      const color = (typeof c === 'object' && c.color) || '#1890ff';
      return buildDotOption(label, value, color);
    });

    // 标签选项
    const tagOptions = (allowedTags || []).map((t: string, i: number) =>
      buildDotOption(t, t, TAG_COMMENT_COLORS[i % TAG_COMMENT_COLORS.length])
    );

    // 预设注释选项
    const commentPresetOptions = (project?.commentPresets || []).map((p: string, i: number) =>
      buildDotOption(p, p, TAG_COMMENT_COLORS[i % TAG_COMMENT_COLORS.length])
    );

    const allCommentOptions = [
      ...commentPresetOptions,
      ...(region.comment && !project?.commentPresets?.includes(region.comment)
        ? [buildDotOption(region.comment, region.comment, '#1890ff')]
        : [])
    ];

    // tags select 多选模式 open 受控，选择后自动关闭下拉
    const [tagsOpen, setTagsOpen] = useState(false);

    // 拖动偏移
    const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>(
      () => dragOffsetsRef.current.get(regionId) || { dx: 0, dy: 0 }
    );

    // 展开 / 关闭
    const openPanel = () => {
      editingRegionIdsRef.current.clear();
      editingRegionIdsRef.current.add(regionId);
      forceUpdate(n => n + 1);
      onOpen?.(region);
    };
    const closePanel = () => {
      editingRegionIdsRef.current.delete(regionId);
      forceUpdate(n => n + 1);
    };

    // Ctrl+拖动逻辑
    const dragStartRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
    const draggingRef = useRef(false);

    const handleTriggerMouseDown = (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.stopPropagation();
        e.preventDefault();
        dragStartRef.current = { sx: e.clientX, sy: e.clientY, ox: dragOffset.dx, oy: dragOffset.dy };
        draggingRef.current = false;
      } else {
        e.stopPropagation();
        e.preventDefault();
        if (!draggingRef.current) openPanel();
      }
    };

    // Ctrl+拖动：全局 mousemove / mouseup 监听
    useEffect(() => {
      const onMove = (e: MouseEvent) => {
        const ds = dragStartRef.current;
        if (!ds) return;
        const dx = ds.ox + (e.clientX - ds.sx);
        const dy = ds.oy + (e.clientY - ds.sy);
        if (Math.abs(e.clientX - ds.sx) > 2 || Math.abs(e.clientY - ds.sy) > 2) {
          draggingRef.current = true;
        }
        dragOffsetsRef.current.set(regionId, { dx, dy });
        setDragOffset({ dx, dy });
      };
      const onUp = () => {
        dragStartRef.current = null;
        // 延迟重置，避免拖动结束触发 click 打开面板
        setTimeout(() => { draggingRef.current = false; }, 100);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }, [regionId]);

    // 面板是否展开
    const isOpen = editingRegionIdsRef.current.has(regionId);

    // 三个圆点颜色：cls / tag / comment
    const clsColor = region.color || getClsColor(region.cls || '');
    const tagColor = (() => {
      const tagVal = tagSingleSelection ? (region.tags?.[0]) : (region.tags?.[0]);
      if (!tagVal || !allowedTags) return '#999';
      const idx = allowedTags.indexOf(tagVal);
      return idx >= 0 ? TAG_COMMENT_COLORS[idx % TAG_COMMENT_COLORS.length] : '#999';
    })();
    const commentColor = (() => {
      const cmt = region.comment;
      if (!cmt || !project?.commentPresets) return '#999';
      const idx = project.commentPresets.indexOf(cmt);
      return idx >= 0 ? TAG_COMMENT_COLORS[idx % TAG_COMMENT_COLORS.length] : '#1890ff';
    })();

    return (
      <div style={{ position: 'relative', zIndex: 20, overflow: 'visible', display: 'inline-block' }}>
        {/* 折叠态：三圆点触发按钮 */}
        {!isOpen && (
          <div
            ref={triggerRef}
            className="region-trigger"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '3px 6px',
              background: 'rgba(255,255,255,0.92)',
              border: '1px solid rgba(0,0,0,0.2)',
              borderRadius: 4,
              boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
              cursor: 'pointer',
              overflow: 'visible',
              pointerEvents: 'auto',
              transform: `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`,
            }}
            onMouseDown={handleTriggerMouseDown}
          >
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: clsColor, flexShrink: 0 }} />
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: tagColor, flexShrink: 0 }} />
            <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: commentColor, flexShrink: 0 }} />
          </div>
        )}

        {/* 展开态：编辑面板 */}
        {isOpen && (
          <div
            style={{
              position: 'relative',
              zIndex: 20,
              minWidth: 180,
              background: '#fff',
              borderRadius: 6,
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              overflow: 'hidden',
            }}
          >
            {/* 顶部栏：三个彩色圆点 + 收起按钮 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 8px',
                background: 'rgba(0,0,0,0.04)',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
              }}
            >
              {/* 三个彩色圆点 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: clsColor, flexShrink: 0 }} />
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: tagColor, flexShrink: 0 }} />
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: commentColor, flexShrink: 0 }} />
              </div>
              {/* 收起按钮：用 onMouseUp 绕过外层 preventDefault */}
              <div
                onMouseUp={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  e.preventDefault();
                  closePanel();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 14,
                  color: '#666',
                  lineHeight: 1,
                  userSelect: 'none',
                }}
                title={t('page.annotation.annotate.collapse')}
              >
                ▲
              </div>
            </div>

            {/* Select 输入区 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 4 }}>
              {allowedClasses?.length > 0 && (
                <ASelect
                  allowClear
                  className="w-full"
                  getPopupContainer={(trigger) => trigger.parentElement || document.body}
                  placeholder={t('page.annotation.project.classes')}
                  size="small"
                  value={region.cls}
                  onChange={(val) => onChange({ ...region, cls: val })}
                  options={classOptions}
                />
              )}
              {allowedTags?.length > 0 && (
                <ASelect
                  allowClear
                  className="w-full"
                  getPopupContainer={(trigger) => trigger.parentElement || document.body}
                  maxTagCount={3}
                  menuItemSelectedIcon={null}
                  mode={tagSingleSelection ? undefined : 'multiple'}
                  open={tagSingleSelection ? undefined : tagsOpen}
                  optionRender={(opt) => opt.label}
                  placeholder={t('page.annotation.project.tags')}
                  size="small"
                  value={tagSingleSelection ? (region.tags?.[0]) : region.tags}
                  onOpenChange={(visible) => setTagsOpen(visible)}
                  onChange={(val) => {
                    const tags = tagSingleSelection ? (val ? [val] : []) : (Array.isArray(val) ? val : []);
                    onChange({ ...region, tags });
                    // 多选模式：选择后关闭下拉，避免遮挡下方 comment 控件
                    if (!tagSingleSelection) {
                      setTagsOpen(false);
                    }
                  }}
                  options={tagOptions}
                />
              )}
              {allowComments && project && project.commentPresets?.length > 0 && (
                <ASelect
                  allowClear
                  className="w-full"
                  getPopupContainer={(trigger) => trigger.parentElement || document.body}
                  placeholder={t('page.annotation.project.commentPresets')}
                  size="small"
                  value={region.comment || undefined}
                  onChange={(val) => onChange({ ...region, comment: val || '' })}
                  options={allCommentOptions}
                />
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // 探测库渲染的 DOM 结构：找到图片容器 → 已标注区域，绑定点击事件
  const annotateContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = annotateContainerRef.current;
    if (!container) return;

    // 直接在 container 上用捕获阶段监听所有 click，检查事件流向
    const containerClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.region-trigger')) {
        console.log('[ContainerCapture] click captured on container, .region-trigger found, target:', target.tagName, target.className, 'eventPhase:', e.eventPhase);
      }
    };
    container.addEventListener('click', containerClickHandler, true);

    // 同时在 document 上用冒泡阶段监听，看事件是否到达顶层
    const docClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest?.('.region-trigger')) {
        console.log('[DocumentBubble] click bubbled to document, .region-trigger found, target:', target.tagName, target.className);
      }
    };
    document.addEventListener('click', docClickHandler);

    // 延迟等库渲染完成后，找到图片容器也加监听
    const timer = setTimeout(() => {
      const canvas = container.querySelector('canvas');
      const imageContainer = canvas?.parentElement;
      if (imageContainer) {
        console.log('[Annotate] Found image container:', imageContainer.tagName, imageContainer.className);
        const imgClickHandler = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          if (target.closest?.('.region-trigger')) {
            console.log('[ImageContainerCapture] click captured on imageContainer, .region-trigger found');
          }
        };
        imageContainer.addEventListener('click', imgClickHandler, true);
      }
    }, 500);

    return () => {
      clearTimeout(timer);
      container.removeEventListener('click', containerClickHandler, true);
      document.removeEventListener('click', docClickHandler);
    };
  }, [annotateImages.length]);

  return (
    <div ref={annotateContainerRef} className="h-full flex-col overflow-hidden annotate-root">
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
        ) : (() => {
          console.log('[Annotate] render check: projectId:', projectId, 'loading:', loading, 'images.length:', images.length, 'project:', !!project, 'annotateImages.length:', annotateImages.length);
          if (project && annotateImages.length > 0) return (
          <ReactImageAnnotate
            key={`annotator-${project.id}`}
            RegionEditLabel={RegionEditLabel}
            allowComments={project.enableComment}
            enabledTools={project.tools || ['create-box']}
            images={annotateImages}
            selectedImage={currentImageIndex}
            regionClsList={project.classes?.map((c, i) => ({ id: c.name, label: c.name, color: CLASS_COLORS[i % CLASS_COLORS.length] })) || []}
            regionTagList={project.tags || []}
            showTags={true}
            taskDescription={project.description || t('page.annotation.annotate.taskDescription')}
            onExit={handleSave}
            onNextImage={handleNextImage}
            onPrevImage={handlePrevImage}
          />
          );
          return (
          <div className="h-full flex-center">
            <ASpin size="large" />
          </div>
          );
        })()}
      </div>
    </div>
  );
};

export default AnnotateWorkspace;
