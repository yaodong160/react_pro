import { filterRoutes } from '@/features/router';


import generatedRoutes from '~react-pages';

function initRoutes() {
  const allRoutes = { ...generatedRoutes };
  const authRoutes: Router.SingleAuthRoute[] = [];
  const cacheRoutes: string[] = [];

  const constantRoutes = filterRoutes(generatedRoutes, null, authRoutes, cacheRoutes);
  // console.log(JSON.stringify(constantRoutes, null, 2));
  return { allRoutes, authRoutes, initCacheRoutes: cacheRoutes, routes: constantRoutes };
}

export const { allRoutes, authRoutes, initCacheRoutes, routes } = initRoutes();

