/**
 * 标注管理 - 本地存储工具
 * 用于在项目管理/图片采集/图片标注之间共享当前选中的项目ID
 */

const STORAGE_KEY = 'annotation_current_project_id';

/** 获取当前项目ID */
export function getCurrentProjectId(): number | null {
  const id = localStg.get(STORAGE_KEY);
  return id ? Number(id) : null;
}

/** 设置当前项目ID */
export function setCurrentProjectId(id: number) {
  localStg.set(STORAGE_KEY, String(id));
}

/** 清除当前项目ID */
export function clearCurrentProjectId() {
  localStg.remove(STORAGE_KEY);
}
