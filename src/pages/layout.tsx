import { Outlet, matchRoutes } from 'react-router-dom';
import type { ShouldRevalidateFunctionArgs } from 'react-router-dom';
import { isStaticSuper, selectUserInfo } from '@/stores/modules';
import { usePrevious, useRoute } from '@/features/router';
import { localStg } from '@/utils/storage';
import { allRoutes } from '@/router';

function handleRouteSwitch(to: Router.Route, from: Router.Route | null) {

  if (to.handle.href) {
    window.open(to.handle.href, '_blank');

    return { path: from?.fullPath as string, replace: true };
  }

  return null;
}

function createRouteGuard(to: Router.Route, roles: string[], isSuper: boolean, previousRoute: Router.Route | null) {
  const loginRoute = '/login';
  const isLogin = Boolean(localStg.get('token'));

  const notFoundRoute = 'notFound';
  const isNotFoundRoute = to.id === notFoundRoute;

  if (!isLogin) {
    if (to.handle.constant && !isNotFoundRoute) {
      return null;
    }

    const query = to.fullPath;

    const location = `${loginRoute}?redirect=${query}`;

    return location;
  }

  const rootRoute = '/';
  const noAuthorizationRoute = '/403';

  const needLogin = !to.handle.constant;
  const routeRoles = to.handle.roles || [];

  const hasRole = roles.some(role => routeRoles.includes(role));

  const hasAuth = isSuper || !routeRoles.length || hasRole;

  if (to.fullPath.includes('login') && to.pathname !== '/login-out' && isLogin) {
    return rootRoute;
  }

  if (to.id === 'notFound') {
    const exist = matchRoutes(allRoutes[0].children || [], to.pathname);

    if (exist && exist.length > 1) {
      return noAuthorizationRoute;
    }

    return null;
  }

  if (!needLogin) {
    return handleRouteSwitch(to, previousRoute);
  }

  if (!hasAuth && import.meta.env.VITE_AUTH_ROUTE_MODE === 'static') {
    return noAuthorizationRoute;
  }

  return handleRouteSwitch(to, previousRoute);
}

/**
 * RootLayout - 根布局组件
 * 
 * 核心职责：
 * 1. 路由守卫：在渲染子页面前检查登录状态和权限。
 * 2. UI 增强：管理页面标题 (Title) 和顶部加载进度条 (NProgress)。
 * 3. 布局容器：通过 <Outlet> 渲染嵌套的子路由页面。
 */
const RootLayout = () => {
  // 1. 获取当前路由的完整信息（包含 path, handle 元数据, params 等）
  const route = useRoute();

  // 2. 获取“上一个路由”对象，用于处理返回逻辑或传递上下文
  const previousRoute = usePrevious(route);

  // 3. 解构当前路由的关键属性
  const { handle, id, pathname } = route;
  // 从路由元数据 (handle) 中获取国际化 Key 和页面标题
  const { i18nKey, title } = handle;

  // 4. 使用 Ref 存储重定向目标，避免不必要的重渲染
  // 类型可以是：字符串路径 | 带有 replace 属性的对象 | null (不跳转)
  const location = useRef<string | { path: string; replace: boolean } | null>(null);

  // 5. 使用 Ref 记录当前路由 ID，用于检测路由是否真正发生了变化
  const routeId = useRef<string>(null);

  // 6. 从 Redux Store 中获取当前用户的角色列表
  const { roles } = useAppSelector(selectUserInfo);

  // 7. 从 Redux Store 中判断当前用户是否为“静态超级管理员”
  const isSuper = useAppSelector(isStaticSuper);

  // 8. 获取国际化翻译函数
  const { t } = useTranslation();

  // --- 副作用：动态设置浏览器标签页标题 ---
  useEffect(() => {
    // 如果配置了 i18nKey 则翻译，否则直接使用 title
    document.title = i18nKey ? t(i18nKey) : title;
  }, [i18nKey, title, t]);

  // --- 副作用：路由加载完成后，关闭顶部进度条 ---
  useEffect(() => {
    window.NProgress?.done?.();
  }, [pathname]); // 监听 pathname 变化，路径变了说明页面加载完了

  // --- 核心逻辑：路由守卫判断 ---
  // 只有当路由 ID 发生变化时，才重新执行守卫逻辑（性能优化）
  if (routeId.current !== id) {
    routeId.current = id; // 更新记录
    
    // 执行守卫函数，返回结果有三种可能：
    // 1. null: 允许通行，渲染子页面
    // 2. string: 重定向到该路径 (如 '/login')
    // 3. object: 重定向到该路径并替换历史记录 (replace: true)
    location.current = createRouteGuard(route, roles, isSuper, previousRoute);
  }

  // --- 渲染逻辑：根据守卫结果决定显示什么 ---
  return location.current ? (
    // 情况 A：需要重定向
    typeof location.current === 'string' ? (
      // 普通跳转
      <Navigate to={location.current} />
    ) : (
      // 替换式跳转 (常用于登录后或退出后，防止回退)
      <Navigate
        replace={location.current.replace}
        to={location.current.path}
      />
    )
  ) : (
    // 情况 B：守卫通过，渲染子路由内容
    // context 属性将 previousRoute 传递给子组件，方便子组件获取“上一页”信息
    <Outlet context={previousRoute} />
  );
};

export const loader = () => {
  window.NProgress?.start?.();

  return null;
};

export const shouldRevalidate = ({ currentUrl, nextUrl }: ShouldRevalidateFunctionArgs) => {
  if (currentUrl.pathname === nextUrl.pathname) {
    return false;
  }
  return true;
};

export default RootLayout;
