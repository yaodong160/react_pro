import { annotationHandlers, cameraHandlers } from './system';
import { authHandlers } from './auth';
import { routeHandlers } from './route';
import { roleHandlers, userHandlers } from './system';

export const handlers = [
  ...authHandlers,
  ...routeHandlers,
  ...userHandlers,
  ...roleHandlers,
  ...annotationHandlers,
  ...cameraHandlers
];

export { authHandlers, routeHandlers, userHandlers, roleHandlers, annotationHandlers, cameraHandlers };
