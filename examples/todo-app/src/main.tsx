import { createRoot } from 'react-dom/client'
import App from './App'
import Editing from './editing'
import './style.css'

createRoot(document.getElementById('root')!).render(<><App /><Editing /></>)
