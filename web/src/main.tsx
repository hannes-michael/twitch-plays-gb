import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Overlay from './Overlay';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found in web/index.html.');
}

const isOverlay = window.location.pathname.replace(/\/+$/, '') === '/overlay';

createRoot(rootElement).render(<StrictMode>{isOverlay ? <Overlay /> : <App />}</StrictMode>);
