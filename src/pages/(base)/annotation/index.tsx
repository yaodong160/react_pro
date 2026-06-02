/**
 * @handle {
 *   "order": 3,
 *   "icon": "majesticons:image-line"
 * }
 */

import { Outlet, redirect } from 'react-router-dom';

const Annotation = () => {
  return <Outlet />;
};

export const loader = () => {
  // 访问 /annotation 时重定向到项目管理
  return redirect('project');
};

export default Annotation;
