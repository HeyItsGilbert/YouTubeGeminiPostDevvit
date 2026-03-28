import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
createRoot(document.getElementById('root')).render(Devvit.createElement(StrictMode, null,
    Devvit.createElement(App, null)));
