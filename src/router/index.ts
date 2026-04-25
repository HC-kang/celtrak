import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/briefing',
    },
    {
      path: '/briefing',
      name: 'briefing',
      component: () => import('@/views/BriefingView.vue'),
    },
    {
      path: '/catalog',
      name: 'catalog',
      component: () => import('@/views/CatalogView.vue'),
    },
    {
      path: '/fleets',
      name: 'fleets',
      component: () => import('@/views/FleetsView.vue'),
    },
    {
      path: '/stations',
      name: 'stations',
      component: () => import('@/views/GroundStationsView.vue'),
    },
    {
      path: '/weather',
      name: 'weather',
      component: () => import('@/views/SpaceWeatherView.vue'),
    },
    {
      path: '/more',
      name: 'more',
      component: () => import('@/views/MoreView.vue'),
    },
  ],
});
