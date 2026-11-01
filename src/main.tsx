import '@mantine/core/styles.css';
import { MantineProvider, createTheme } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';

/** 部署到子路径（GitHub Pages）时，路由 basename 需要与 vite base 保持一致 */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

const theme = createTheme({});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <BrowserRouter basename={ROUTER_BASENAME}>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>
);
