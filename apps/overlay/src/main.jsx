import React from 'react';
import { createRoot } from 'react-dom/client';
import Overlay from './notify/Overlay.jsx';
// Resolved by vite.config.js: the module named by OVERLAY_VIEWS, or src/views.default.js (no custom kinds).
import { views } from 'overlay-views';
import './overlay.css';

createRoot(document.getElementById('root')).render(<Overlay views={views} />);
