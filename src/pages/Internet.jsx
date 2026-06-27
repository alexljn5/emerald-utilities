import { useEffect, useRef, useState, useCallback } from 'react';
import PageShell from './PageShell.jsx';
import '../css/internet.css';

const generateTabId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function Internet({ route, setRoute }) {
    const containerRef = useRef(null);
    const [tabs, setTabs] = useState([{ id: generateTabId(), url: 'https://www.google.com', title: 'New Tab' }]);
    const [activeTabId, setActiveTabId] = useState(tabs[0].id);
    const [inputValue, setInputValue] = useState('https://www.google.com');
    const [extensions, setExtensions] = useState([]);
    const [showExtensions, setShowExtensions] = useState(false);
    const [newExtensionScript, setNewExtensionScript] = useState('');

    const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

    // Setup browser view for active tab
    useEffect(() => {
        let cancelled = false;

        async function setupBrowser() {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const bounds = {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            };

            if (!cancelled) {
                try {
                    await window.electronAPI.invoke('internet:switch-tab', { tabId: activeTabId, bounds });
                } catch (err) {
                    console.error('Failed to show browser:', err);
                }
            }
        }

        setupBrowser();

        const handleResize = () => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const bounds = {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            };
            window.electronAPI.invoke('internet:switch-tab', { tabId: activeTabId, bounds }).catch(() => { });
        };

        window.addEventListener('resize', handleResize);

        return () => {
            cancelled = true;
            window.removeEventListener('resize', handleResize);
            window.electronAPI.invoke('internet:hide').catch(() => { });
        };
    }, [activeTabId]);



    const navigateTo = useCallback((targetUrl) => {
        let normalized = targetUrl.trim();
        if (!normalized) return;

        if (!/^https?:\/\//i.test(normalized)) {
            normalized = 'https://' + normalized;
        }

        setInputValue(normalized);
        setTabs(prev => prev.map(t =>
            t.id === activeTabId ? { ...t, url: normalized } : t
        ));
        window.electronAPI.invoke('internet:navigate', { tabId: activeTabId, url: normalized }).catch(() => { });
    }, [activeTabId]);

    const handleSubmit = (e) => {
        e.preventDefault();
        navigateTo(inputValue);
    };

    const createNewTab = async () => {
        const newTab = { id: generateTabId(), url: 'https://www.google.com', title: 'New Tab' };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
        setInputValue(newTab.url);
    };

    const closeTab = async (tabId, e) => {
        e.stopPropagation();
        if (tabs.length === 1) return; // Don't close last tab

        await window.electronAPI.invoke('internet:close-tab', tabId);
        const newTabs = tabs.filter(t => t.id !== tabId);
        setTabs(newTabs);

        if (activeTabId === tabId) {
            const newActiveId = newTabs[newTabs.length - 1].id;
            setActiveTabId(newActiveId);
            setInputValue(newTabs[newTabs.length - 1].url);
        }
    };

    const switchTab = (tabId) => {
        const tab = tabs.find(t => t.id === tabId);
        if (tab) {
            setActiveTabId(tabId);
            setInputValue(tab.url);
        }
    };

    const addExtension = () => {
        if (!newExtensionScript.trim()) return;
        const ext = {
            id: `ext-${Date.now()}`,
            script: newExtensionScript,
            enabled: true
        };
        setExtensions(prev => [...prev, ext]);
        setNewExtensionScript('');
        setShowExtensions(false);

        // Inject into active tab
        window.electronAPI.invoke('internet:inject-script', {
            tabId: activeTabId,
            script: ext.script
        }).catch(() => { });
    };

    const toggleExtension = (extId) => {
        setExtensions(prev => prev.map(ext =>
            ext.id === extId ? { ...ext, enabled: !ext.enabled } : ext
        ));
    };

    const removeExtension = (extId) => {
        setExtensions(prev => prev.filter(ext => ext.id !== extId));
    };

    return (
        <PageShell title="Internet" route={route} setRoute={setRoute} leftChildren={
            <>
                <form className="internetAddressBar" onSubmit={handleSubmit}>
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="Enter URL or search..."
                        spellCheck={false}
                    />
                    <button type="submit">Go</button>
                </form>

                <div className="internetTabs">
                    {tabs.map(tab => (
                        <div
                            key={tab.id}
                            className={`internetTab ${tab.id === activeTabId ? 'active' : ''}`}
                            onClick={() => switchTab(tab.id)}
                        >
                            <span className="internetTabTitle">{tab.title}</span>
                            {tabs.length > 1 && (
                                <button
                                    className="internetTabClose"
                                    onClick={(e) => closeTab(tab.id, e)}
                                >×</button>
                            )}
                        </div>
                    ))}
                    <button className="internetTabNew" onClick={createNewTab}>+</button>
                </div>

                <div className="internetExtensions">
                    <button
                        className="internetExtensionsToggle"
                        onClick={() => setShowExtensions(!showExtensions)}
                    >
                        {showExtensions ? '▼ Extensions' : '▶ Extensions'}
                    </button>
                    {showExtensions && (
                        <div className="internetExtensionsList">
                            {extensions.map(ext => (
                                <div key={ext.id} className="internetExtensionItem">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={ext.enabled}
                                            onChange={() => toggleExtension(ext.id)}
                                        />
                                        <span>Script</span>
                                    </label>
                                    <button onClick={() => removeExtension(ext.id)}>×</button>
                                </div>
                            ))}
                            <div className="internetExtensionAdd">
                                <textarea
                                    value={newExtensionScript}
                                    onChange={(e) => setNewExtensionScript(e.target.value)}
                                    placeholder="Paste JavaScript to inject..."
                                    rows={3}
                                />
                                <button onClick={addExtension}>Inject</button>
                            </div>
                        </div>
                    )}
                </div>
            </>
        }>
            <div ref={containerRef} className="internetBrowserContainer" />
        </PageShell>
    );
}
