import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { parseTcpdumpArgs } from '../core/tcpdumpArgs.js';
import { networkManager } from '../core/networkManager.js';
import { invoke } from '../js/electronApi.js';
import eye from '../../img/network-overseer/network-overseer-eye.png';
import hand from '../../img/network-overseer/network-overseer-hand.png';
import wing from '../../img/network-overseer/network-overseer-wing.png';
import '../css/network-monitoring.css';

function BinaryStream({ text = "01010101 10101010 11001100", vertical = false, reverse = false }) {
    return (
        <div
            className={`binaryStream ${vertical ? 'vertical' : ''} ${reverse ? 'reverse' : ''}`}
            aria-hidden="true"
        >
            {text}
        </div>
    );
}

export default function NetworkMonitoring({ route, setRoute }) {
    const [state, setState] = useState({
        isCapturing: networkManager.state.isCapturing,
        logs: [...(networkManager.state.logs || [])],
        parserLogs: [...(networkManager.state.parserLogs || [])],
        latestPacket: networkManager.state.latestPacket || null,
        status: networkManager.state.status
    });

    const [captureInterface, setCaptureInterface] = useState('any');
    const [tcpdumpArgs, setTcpdumpArgs] = useState('');
    const [captureError, setCaptureError] = useState('');

    const [busy, setBusy] = useState(false);
    const [showPacketLogs, setShowPacketLogs] = useState(false);
    const [packetLogFolder, setPacketLogFolder] = useState('ALL');
    const [packetLogFiles, setPacketLogFiles] = useState([]);
    const [selectedPacketLogFile, setSelectedPacketLogFile] = useState(null);
    const [packetLogContent, setPacketLogContent] = useState('');
    const [packetLogLoading, setPacketLogLoading] = useState(false);
    const [packetLogError, setPacketLogError] = useState('');
    const logBoxRef = useRef(null);
    const parserLogsRef = useRef(null);
    const packetLogViewerRef = useRef(null);

    useEffect(() => {
        let cancelled = false;

        networkManager.syncCaptureStatus().catch((err) => {
            if (!cancelled) setCaptureError(err?.message || 'Unable to sync capture status');
        });

        const unsubscribe = networkManager.onStateChange((next) => {
            if (cancelled) return;

            setState({
                isCapturing: next.isCapturing,
                logs: [...(next.logs || [])],
                parserLogs: [...(next.parserLogs || [])],
                latestPacket: next.latestPacket || null,
                status: next.status
            });
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
        if (parserLogsRef.current) parserLogsRef.current.scrollTop = parserLogsRef.current.scrollHeight;
    }, [state.logs, state.parserLogs]);

    useEffect(() => {
        if (!showPacketLogs) return;

        let cancelled = false;

        async function loadPacketLogs() {
            setPacketLogLoading(true);
            setPacketLogError('');

            try {
                const listResult = await invoke('network-logs:list', { folder: packetLogFolder });
                if (cancelled) return;

                if (!listResult?.ok) {
                    setPacketLogFiles([]);
                    setSelectedPacketLogFile(null);
                    setPacketLogContent('');
                    setPacketLogError(listResult?.error || 'Unable to list packet logs');
                    return;
                }

                const files = listResult.files || [];
                const fileToRead = selectedPacketLogFile && files.includes(selectedPacketLogFile)
                    ? selectedPacketLogFile
                    : files[0] || null;

                setPacketLogFiles(files);
                setSelectedPacketLogFile(fileToRead);

                if (!fileToRead) {
                    setPacketLogContent('');
                    return;
                }

                const readResult = await invoke('network-logs:read', {
                    folder: packetLogFolder,
                    file: fileToRead
                });

                if (cancelled) return;

                if (!readResult?.ok) {
                    setPacketLogContent('');
                    setPacketLogError(readResult?.error || 'Unable to read packet log');
                    return;
                }

                setPacketLogContent(readResult.content || '');
            } catch (err) {
                if (cancelled) return;
                setPacketLogFiles([]);
                setSelectedPacketLogFile(null);
                setPacketLogContent('');
                setPacketLogError(err?.message || 'Unable to load packet logs');
            } finally {
                if (!cancelled) setPacketLogLoading(false);
            }
        }

        loadPacketLogs();

        return () => {
            cancelled = true;
        };
    }, [showPacketLogs, packetLogFolder, selectedPacketLogFile]);

    useEffect(() => {
        if (showPacketLogs && packetLogViewerRef.current) {
            packetLogViewerRef.current.scrollTop = packetLogViewerRef.current.scrollHeight;
        }
    }, [showPacketLogs, packetLogContent, packetLogError]);

    async function toggleCapture() {
        if (busy) return;
        setBusy(true);
        setCaptureError('');

        try {
            if (state.isCapturing) {
                await networkManager.stopCapture();
            } else {
                const parsedArgs = parseTcpdumpArgs(tcpdumpArgs);
                const started = await networkManager.startCapture({
                    interface: captureInterface,
                    tcpdumpArgs: parsedArgs
                });

                if (!started) {
                    setCaptureError('Unable to start capture');
                }
            }
        } catch (e) {
            setCaptureError(e?.message || 'Unable to start capture');
            console.error(e);
        } finally {
            setBusy(false);
        }
    }

    function clearLogs() {
        networkManager.clearLogs();
    }

    const latestBinary = state.latestPacket?.binary || "01010101 10101010 11001010 11001100";
    const packetLogSummary = packetLogFiles.length > 0
        ? `${packetLogFiles.length} saved file${packetLogFiles.length === 1 ? '' : 's'} in ${packetLogFolder}`
        : `No saved ${packetLogFolder} logs yet`;
    const statusClass = state.isCapturing ? 'statusCapturing' : state.status?.startsWith('Error') ? 'statusError' : 'statusIdle';

    return (
        <PageShell title="Network Monitoring" route={route} setRoute={setRoute} leftChildren={
            <div className="networkSidebar">
                <div className="navBox">
                    <h3>Controls</h3>
                    <button className="full" disabled={busy} onClick={toggleCapture}>
                        {state.isCapturing ? '⏹ Stop Capture' : '▶ Start Capture'}
                    </button>

                    <form className="captureForm" onSubmit={(event) => event.preventDefault()}>
                        <label>
                            Interface
                            <input
                                value={captureInterface}
                                disabled={busy || state.isCapturing}
                                placeholder="any"
                                onChange={(event) => setCaptureInterface(event.target.value)}
                            />
                        </label>

                        <label>
                            tcpdump args
                            <input
                                value={tcpdumpArgs}
                                disabled={busy || state.isCapturing}
                                placeholder="-s 0 port 443"
                                onChange={(event) => setTcpdumpArgs(event.target.value)}
                            />
                        </label>
                    </form>

                    {captureError ? <div className="captureError">{captureError}</div> : null}

                    <button className="full" onClick={clearLogs}>Clear Logs</button>
                </div>

                <div className="navBox">
                    <h3>Capture Status</h3>
                    <div className={statusClass}>{state.status}</div>
                </div>

                <div className="navBox packetLogsBox">
                    <h3>Packet Logs</h3>
                    <button className="full" type="button" onClick={() => setShowPacketLogs(true)}>
                        View Packet Logs
                    </button>
                    <div className="packetLogSummary">{packetLogSummary}</div>
                </div>
            </div>
        }>
            <div className="networkOverseer">
                <div className={`packetLogViewer${showPacketLogs ? '' : ' hidden'}`}>
                    <div className="packetLogViewerHeader">
                        <h3>Packet Log Files</h3>
                        <button type="button" onClick={() => setShowPacketLogs(false)}>Close</button>
                    </div>

                    <div className="packetLogViewerToolbar">
                        <label>
                            Log Folder
                            <select value={packetLogFolder} onChange={(event) => setPacketLogFolder(event.target.value)}>
                                <option value="ALL">ALL</option>
                                <option value="FILTERED">FILTERED</option>
                            </select>
                        </label>

                        <label>
                            File
                            <select
                                value={selectedPacketLogFile || ''}
                                onChange={(event) => setSelectedPacketLogFile(event.target.value || null)}
                                disabled={!packetLogFiles.length || packetLogLoading}
                            >
                                <option value="">
                                    {packetLogLoading ? 'Loading...' : packetLogFiles.length ? 'Select file' : 'No files'}
                                </option>
                                {packetLogFiles.map((file) => (
                                    <option key={file} value={file}>{file}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <div className="packetLogViewerContent" ref={packetLogViewerRef}>
                        {packetLogError ? (
                            <div className="packetLogViewerError">{packetLogError}</div>
                        ) : packetLogLoading ? (
                            <div className="packetLogViewerEmpty">Loading packet logs...</div>
                        ) : packetLogContent ? (
                            <pre className="packetLogViewerRaw">{packetLogContent}</pre>
                        ) : (
                            <div className="packetLogViewerEmpty">No packet log files in {packetLogFolder}. Start a capture to create logs.</div>
                        )}
                    </div>
                </div>
                <div className="overseerGraphic">
                    <img src={eye} alt="Overseer Eye" className="overseerEye" />

                    <div className="overseerDiagram">
                        {/* User Traffic Log → Parser */}
                        <div className="binaryTunnel horizontalTunnel leftTunnel">
                            <BinaryStream text={latestBinary} reverse />
                        </div>

                        {/* Full Packet Capture → Parser */}
                        <div className="binaryTunnel horizontalTunnel rightTunnel">
                            <BinaryStream text={latestBinary} />
                        </div>

                        {/* Parser → Parser Logs */}
                        <div className="binaryTunnel verticalTunnel">
                            <BinaryStream text={latestBinary} vertical reverse />
                        </div>

                        {/* Left box - reserved for future user traffic parsing */}
                        <div className="redBox logBox userTrafficBox">
                            <div className="logBoxHeader">User Traffic Log</div>
                            <div className="logBoxContent">
                                <div className="logPlaceholder">reserved / empty</div>
                            </div>
                        </div>

                        {/* Central Parser */}
                        <div className="redBox parserBox">
                            <div className="parserBoxHeader">Parser</div>
                            <div className="parserCore">
                                stdout → JS → JSON
                            </div>
                        </div>

                        {/* Right box - Full Packet Capture */}
                        <div className="redBox logBox fullPacketBox">
                            <div className="logBoxHeader">Full Packet Capture</div>
                            <div className="logBoxContent" ref={logBoxRef}>
                                {state.logs.length === 0 ? (
                                    <div className="logPlaceholder">
                                        {state.isCapturing ? 'Capturing...' : 'No packets yet. Click Start Capture.'}
                                    </div>
                                ) : (
                                    state.logs.map((line, i) => <div key={i} className="logLine">{line}</div>)
                                )}
                            </div>
                        </div>

                        {/* Bottom - Parser logs */}
                        <div className="redBox logBox parserLogsBox">
                            <div className="logBoxHeader">Parser Logs</div>
                            <div className="logBoxContent parserLogContent" ref={parserLogsRef}>
                                {state.latestPacket ? (
                                    <div>
                                        <strong>Summary:</strong> {state.latestPacket.packet?.summary || 'Packet received'}<br />
                                        <strong>Binary:</strong>
                                        <div className="parserBinary">{state.latestPacket.binary}</div>
                                    </div>
                                ) : (
                                    <div className="logPlaceholder">No parsed packets yet. Start capture.</div>
                                )}
                            </div>
                        </div>
                    </div>

                    <img src={wing} alt="Left overseer wing" className="overseerWing left" />
                    <img src={wing} alt="Right overseer wing" className="overseerWing right" />
                    <img src={hand} alt="Left hand" className="overseerHand left" />
                    <img src={hand} alt="Right hand" className="overseerHand right" />
                </div>
            </div>
        </PageShell>
    );
}