import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { router } from './app/router';
import { initSentry } from './app/utils/sentry';
import './styles/index.css';

initSentry();

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);
