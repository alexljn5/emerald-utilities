import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './pages/Dashboard.jsx';
import ScriptTool from './pages/ScriptTool.jsx';
import NetworkMonitoring from './pages/NetworkMonitoring.jsx';
import TheAI from './pages/TheAI.jsx';
import About from './pages/About.jsx';
import ModUpdater from './pages/ModUpdater.jsx';
import Settings from './pages/Settings.jsx';
import Internet from './pages/Internet.jsx';
import Database from './pages/Database.jsx';
import PortfolioMonitor from './pages/PortfolioMonitor.jsx';
import CreatorHub from './creator-hub/ui/CreatorHubPage.jsx';
import Tasks from './pages/Tasks.jsx';
import './css/globals.css';
import './css/creator-hub.css';
import './css/tasks.css';

const pages = {
    dashboard: Dashboard,
    scriptTool: ScriptTool,
    networkMonitoring: NetworkMonitoring,
    modUpdater: ModUpdater,
    ai: TheAI,
    about: About,
    settings: Settings,
    internet: Internet,
    database: Database,
    portfolio: PortfolioMonitor,
    creatorHub: CreatorHub,
    tasks: Tasks
};

function App() {
    const [route, setRoute] = useState('dashboard');
    const Page = pages[route] ?? Dashboard;

    return <Page route={route} setRoute={setRoute} />;
}

createRoot(document.getElementById('root')).render(<App />);
