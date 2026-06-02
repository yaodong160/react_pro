import { request } from '../request';

// ==================== 用户管理接口 ====================

/**
 * 获取用户列表
 */
export function fetchGetUserList(params?: Api.SystemManage.UserSearchParams) {
  console.log('🔶 API: 发送获取用户列表请求', params);
  
  return request<Api.SystemManage.UserList>({
    method: 'get',
    url: '/system/user/list',
    params
  });
}

/**
 * 新增用户
 */
export function fetchAddUser(data: Omit<Api.SystemManage.User, 'id' | 'createTime' | 'updateTime'>) {
  return request<Api.SystemManage.User>({
    method: 'post',
    url: '/system/user/add',
    data
  });
}

/**
 * 编辑用户
 */
export function fetchEditUser(id: number, data: Partial<Api.SystemManage.User>) {
  return request<Api.SystemManage.User>({
    method: 'put',
    url: `/system/user/edit/${id}`,
    data
  });
}

/**
 * 删除用户
 */
export function fetchDeleteUser(id: number) {
  return request<void>({
    method: 'delete',
    url: `/system/user/delete/${id}`
  });
}

/**
 * 批量删除用户
 */
export function fetchBatchDeleteUser(ids: number[]) {
  return request<void>({
    method: 'delete',
    url: '/system/user/batchDelete',
    data: { ids }
  });
}

/**
 * 获取用户详情
 */
export function fetchGetUserDetail(id: number) {
  return request<Api.SystemManage.User>({
    method: 'get',
    url: `/system/user/detail/${id}`
  });
}

// ==================== 角色管理接口 ====================

/**
 * 获取所有角色（用于用户角色选择）
 */
export function fetchGetAllRoles() {
  return request<Api.SystemManage.AllRole[]>({
    method: 'get',
    url: '/system/role/all'
  });
}

/**
 * 获取角色列表
 */
export function fetchGetRoleList(params: Api.SystemManage.RoleSearchParams) {
  return request<Api.SystemManage.RoleList>({
    method: 'get',
    url: '/system/role/list',
    params
  });
}

/**
 * 新增角色
 */
export function fetchAddRole(data: Omit<Api.SystemManage.Role, 'id' | 'createTime' | 'updateTime'>) {
  return request<Api.SystemManage.Role>({
    method: 'post',
    url: '/system/role/add',
    data
  });
}

/**
 * 编辑角色
 */
export function fetchEditRole(id: number, data: Partial<Api.SystemManage.Role>) {
  return request<Api.SystemManage.Role>({
    method: 'put',
    url: `/system/role/edit/${id}`,
    data
  });
}

/**
 * 删除角色
 */
export function fetchDeleteRole(id: number) {
  return request<void>({
    method: 'delete',
    url: `/system/role/delete/${id}`
  });
}

// ==================== 角色权限接口 ====================

/**
 * 获取角色菜单权限（含全部菜单树 + 已选ID）
 */
export function fetchGetRoleMenus(roleId: number) {
  return request<{ checkedIds: number[]; tree: Api.SystemManage.MenuTree[] }>({
    method: 'get',
    url: `/system/role/menu/${roleId}`
  });
}

/**
 * 保存角色菜单权限
 */
export function fetchSaveRoleMenus(roleId: number, menuIds: number[]) {
  return request<void>({
    method: 'put',
    url: `/system/role/menu/${roleId}`,
    data: { menuIds }
  });
}

/**
 * 获取角色按钮权限（按菜单分组）
 */
export function fetchGetRolePermissions(roleId: number) {
  return request<{ checkedKeys: React.Key[]; allPermissions: { key: string; title: string; children?: { key: string; title: string }[] }[] }>({
    method: 'get',
    url: `/system/role/permission/${roleId}`
  });
}

/**
 * 保存角色按钮权限
 */
export function fetchSaveRolePermissions(roleId: number, permissionIds: number[]) {
  return request<void>({
    method: 'put',
    url: `/system/role/permission/${roleId}`,
    data: { permissionIds }
  });
}

// ==================== 标注项目管理接口 ====================

/**
 * 获取标注项目列表
 */
export function fetchGetProjectList(params?: Api.Annotation.ProjectSearchParams) {
  return request<Api.Annotation.ProjectList>({
    method: 'get',
    url: '/annotation/project/list',
    params
  });
}

/**
 * 新增标注项目
 */
export function fetchAddProject(data: Api.Annotation.ProjectCreateParams) {
  return request<{ projectId: number; uploadUrl: string }>({
    method: 'post',
    url: '/annotation/project/add',
    data
  });
}

/**
 * 编辑标注项目
 */
export function fetchEditProject(id: number, data: Partial<Api.Annotation.ProjectCreateParams>) {
  return request<Api.Annotation.Project>({
    method: 'put',
    url: `/annotation/project/edit/${id}`,
    data
  });
}

/**
 * 删除标注项目
 */
export function fetchDeleteProject(id: number) {
  return request<void>({
    method: 'delete',
    url: `/annotation/project/delete/${id}`
  });
}

/**
 * 获取标注项目详情
 */
export function fetchGetProjectDetail(id: number) {
  return request<Api.Annotation.Project>({
    method: 'get',
    url: `/annotation/project/detail/${id}`
  });
}

// ==================== 标注图片管理接口 ====================

/**
 * 获取项目图片列表
 * GET /api/annotation/image/list?projectId=1&current=1&size=20&annotateStatus=
 */
export function fetchGetImageList(params: { projectId: number; current?: number; size?: number; annotateStatus?: string | null }) {
  return request<Api.Annotation.ImageList>({
    method: 'get',
    url: '/annotation/image/list',
    params: {
      projectId: params.projectId,
      current: params.current || 1,
      size: params.size || 20,
      annotateStatus: params.annotateStatus ?? undefined
    }
  });
}

/**
 * 上传图片到项目
 * POST /api/upload/image
 * 表单: files（File[]）+ project_id（int）
 */
export function fetchUploadImages(projectId: number, files: File[]) {
  const formData = new FormData();
  formData.append('project_id', String(projectId));
  files.forEach(file => formData.append('files', file));
  return request<Api.Annotation.UploadImageResult>({
    method: 'post',
    url: '/upload/image',
    data: formData
  });
}

/**
 * 删除图片
 */
export function fetchDeleteImage(id: number) {
  return request<void>({
    method: 'delete',
    url: `/upload/delete/${id}`
  });
}

// ==================== 标注结果接口 ====================

/**
 * 获取某张图片的标注结果
 */
export function fetchGetImageResults(imageId: number) {
  return request<Api.Annotation.RegionData[]>({
    method: 'get',
    url: `/annotation/result/image/${imageId}`
  });
}

/**
 * 保存标注结果（单张图片的全部 regions）
 */
export function fetchSaveImageResults(projectId: number, imageId: number, regions: Api.Annotation.RegionData[]) {
  return request<void>({
    method: 'post',
    url: '/annotation/result/save',
    data: { projectId, imageId, regions }
  });
}

/**
 * 获取项目所有标注结果
 */
export function fetchGetProjectResults(projectId: number) {
  return request<Api.Annotation.ImageResult[]>({
    method: 'get',
    url: `/annotation/result/project/${projectId}`
  });
}