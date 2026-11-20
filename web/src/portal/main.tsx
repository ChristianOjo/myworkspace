import React from 'react';
import { createRoot } from 'react-dom/client';
import { PortalApp } from './PortalApp';
import '../styles/global.css';
import './portal.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PortalApp />
  </React.StrictMode>,
);
