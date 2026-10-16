import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DeviceFrame } from './DeviceFrame';
import { WALL_PROFILE } from './profile';
import './styles/tokens.css';
import './styles/wall.css';
import { createWallSession } from './wall-session';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing the #root element');

// Created and started once here, never in an effect: StrictMode runs effects twice in development,
// which would mint two kitchens.
const session = createWallSession({ baseUrl: new URL(window.location.origin), profile: WALL_PROFILE });
void session.start();

createRoot(root).render(
  <StrictMode>
    <DeviceFrame>
      <App session={session} />
    </DeviceFrame>
  </StrictMode>,
);
