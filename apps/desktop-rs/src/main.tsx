import { createRoot } from 'react-dom/client';
import App from './ui/App';
import Widget from './ui/Widget';
import Overlay from './ui/Overlay';
import './styles.css';

/**
 * 路由约定（不引路由库，三个窗口各自固定）：
 * - 主窗口：#/  → App
 * - 小组件：#/widget → Widget
 * - 浮层：#/overlay → Overlay
 */
const hash = window.location.hash;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

if (hash.startsWith('#/widget')) {
  createRoot(container).render(<Widget />);
} else if (hash.startsWith('#/overlay')) {
  createRoot(container).render(<Overlay />);
} else {
  createRoot(container).render(<App />);
}
