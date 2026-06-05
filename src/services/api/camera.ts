import { request } from '../request';

/**
 * 检查摄像头连通性
 * GET /api/camera/check/:projectId
 */
export function fetchCameraCheck(projectId: number) {
  return request<Api.Camera.CheckResult>({
    method: 'get',
    url: `/camera/check/${projectId}`
  });
}

/**
 * 截取当前帧并保存
 * POST /api/camera/capture/:projectId
 */
export function fetchCameraCapture(projectId: number) {
  return request<Api.Camera.CaptureResult>({
    method: 'post',
    url: `/camera/capture/${projectId}`
  });
}

/**
 * 云台控制
 * POST /api/camera/ptz/:projectId
 */
export function fetchCameraPtz(projectId: number, params: Api.Camera.PtzParams, signal?: AbortSignal) {
  return request<void>({
    method: 'post',
    url: `/camera/ptz/${projectId}`,
    data: params,
    signal
  });
}

/**
 * 获取可用分辨率列表
 * GET /api/camera/resolutions/:projectId
 */
export function fetchCameraResolutions(projectId: number) {
  return request<Api.Camera.ResolutionsResult>({
    method: 'get',
    url: `/camera/resolutions/${projectId}`
  });
}

/**
 * 设置分辨率
 * PUT /api/camera/resolution/:projectId
 */
export function fetchSetCameraResolution(projectId: number, resolution: Api.Camera.Resolution) {
  return request<void>({
    method: 'put',
    url: `/camera/resolution/${projectId}`,
    data: resolution
  });
}
