import { useEffect, useRef, useState, useCallback } from 'react';
import PageShell from './PageShell.jsx';
import '../css/internet.css';

const generateTabId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function Internet({ route, setRoute }) {
    const containerRef = useRef(null);
    const [tabs, setTabs] = useState([{ id: generateTabId(), url: 'https://www.google.com', title: 'New Tab' }]);
    const [activeTabId, setActiveTabId] = useState(tabs[0].id);
    const [inputValue, setInputValue] = useState('https://www.google.com');
    const [isPlaying, setIsPlaying] = useState(false);
    const [frequencies, setFrequencies] = useState(new Uint8Array(128));
    const [extensions, setExtensions] = useState([]);
    const [showExtensions, setShowExtensions] = useState(false);
    const [newExtensionScript, setNewExtensionScript] = useState('');
    const canvasRef = useRef(null);
    const animationRef = useRef(null);

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

    // Poll real audio data from BrowserView for soundwave
    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const result = await window.electronAPI.invoke('internet:get-audio-levels', activeTabId);
                if (result?.ok) {
                    setIsPlaying(result.isPlaying);
                    if (result.frequencies && result.frequencies.length > 0) {
                        setFrequencies(new Uint8Array(result.frequencies));
                    }
                }
            } catch (err) {
                // Silently fail
            }
        }, 100);

        return () => clearInterval(interval);
    }, [activeTabId]);

    // Soundwave visualizer using real frequency data from BrowserView
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const draw = () => {
            if (!canvas || !ctx) return;

            const width = canvas.width = canvas.offsetWidth * 2;
            const height = canvas.height = canvas.offsetHeight * 2;
            ctx.clearRect(0, 0, width, height);

            if (isPlaying && frequencies.some(v => v > 0)) {
                // Real audio visualization
                const bufferLength = frequencies.length;
                const barWidth = (width / bufferLength) * 2.5;
                let x = 0;

                for (let i = 0; i < bufferLength; i++) {
                    const value = frequencies[i] || 0;
                    const barHeight = (value / 255) * height;
                    const alpha = Math.max(0.2, value / 255);
                    ctx.fillStyle = `rgba(255, 34, 34, ${alpha})`;
                    ctx.fillRect(x, height - barHeight, barWidth, barHeight);
                    x += barWidth + 1;
                }
            } else {
                // Idle animation - subtle wave when no audio
                const time = Date.now() / 1000;
                ctx.strokeStyle = 'rgba(255, 34, 34, 0.3)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (let x = 0; x < width; x++) {
                    const y = height / 2 + Math.sin(x * 0.02 + time * 2) * 10;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }

            animationRef.current = requestAnimationFrame(draw);
        };

        draw();

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [isPlaying, frequencies]);

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

                <div className="internetSoundwave">
                    <canvas ref={canvasRef} className="soundwaveCanvas" />
                    <span className="soundwaveLabel">{isPlaying ? '♪ Playing' : '○ Idle'}</span>
                </div>
            </>
        }>
            <div ref={containerRef} className="internetBrowserContainer" />
        </PageShell>
    );
}
