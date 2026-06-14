import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './pages/Dashboard.jsx';
import ScriptTool from './pages/ScriptTool.jsx';
import NetworkMonitoring from './pages/NetworkMonitoring.jsx';
import About from './pages/About.jsx';
import './css/globals.css';

const pages = {
    dashboard: Dashboard,
    scriptTool: ScriptTool,
    networkMonitoring: NetworkMonitoring,
    about: About
};

function App() {
    const [route, setRoute] = useState('dashboard');
    const Page = pages[route] ?? Dashboard;

    return <Page route={route} setRoute={setRoute} />;
}

createRoot(document.getElementById('root')).render(<App />);
