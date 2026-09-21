import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import WorkersPage from './pages/WorkersPage.tsx'

const path = window.location.pathname.replace(/\/+$/, '') || '/'
const isWorkers = path === '/workers' || path.endsWith('/workers')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWorkers ? <WorkersPage /> : <App />}
  </StrictMode>,
)
