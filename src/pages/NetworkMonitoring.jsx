import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { networkManager } from '../core/networkManager.js';
import eye from '../../img/network-overseer/network-overseer-eye.png';
import hand from '../../img/network-overseer/network-overseer-hand.png';
import '../css/network-monitoring.css';

function BinaryStream({ vertical = false, reverse = false }) {
    const count = vertical ? 96 : 64;
    const glyphs = Array.from({ length: count }, (_, index) => {
        if (index % 11 === 0) return '1';
        if (index % 7 === 0) return '0';
        return (index * 3 + 5) % 2;
    }).join('');

    return (
        <div className={`binaryStream ${vertical ? 'vertical' : ''} ${reverse ? 'reverse' : ''}`} aria-hidden="true">
            {glyphs}
        </div>
    );
}

function PacketTransform({ entry }) {
    if (!entry) return null;

    return (
        <div className="packetTransform">
            <div className="transformSection">
                <span className="transformLabel">JS input</span>
                <pre className="packetRaw">{entry.raw}</pre>
            </div>

            <div className="transformArrow" aria-hidden="true">↓</div>

            <div className="transformSection">
                <span className="transformLabel">JSON output</span>
                <pre className="packetJson">{JSON.stringify(entry.packet, null, 2)}</pre>
            </div>

            <div className="transformSection binarySection">
                <span className="transformLabel">binary preview</span>
                <code>{entry.binary}</code>
            </div>
        </div>
    );
}

export default function NetworkMonitoring({ route, setRoute }) {
    const [state, setState] = useState({
        isCapturing: networkManager.state.isCapturing,
        logs: [...networkManager.state.logs],
        parserLogs: [...networkManager.state.parserLogs],
        latestPacket: networkManager.state.latestPacket,
        binaryPreview: networkManager.state.binaryPreview,
        status: networkManager.state.status
    });
    const [busy, setBusy] = useState(false);
    const logBoxRef = useRef(null);
    const parserLogsRef = useRef(null);

    useEffect(() => {
        return networkManager.onStateChange((nextState) => {
            setState({
                isCapturing: nextState.isCapturing,
                logs: [...nextState.logs],
                parserLogs: [...nextState.parserLogs],
                latestPacket: nextState.latestPacket,
                binaryPreview: nextState.binaryPreview,
                status: nextState.status
            });
        });
    }, []);

    useEffect(() => {
        if (logBoxRef.current) {
            logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
            requestAnimationFrame(() => {
                if (logBoxRef.current) {
                    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
                }
            });
        }

        if (parserLogsRef.current) {
            parserLogsRef.current.scrollTop = parserLogsRef.current.scrollHeight;
            requestAnimationFrame(() => {
                if (parserLogsRef.current) {
                    parserLogsRef.current.scrollTop = parserLogsRef.current.scrollHeight;
                }
            });
        }
    }, [state.logs, state.parserLogs]);

    async function toggleCapture() {
        if (busy) return;

        setBusy(true);

        try {
            if (state.isCapturing) {
                await networkManager.stopCapture();
            } else {
                const started = await networkManager.startCapture();
                if (!started) {
                    networkManager.state.status = 'Error: capture did not start';
                    networkManager.emit();
                }
            }
        } catch (error) {
            networkManager.state.isCapturing = false;
            networkManager.state.status = `Error: ${error instanceof Error ? error.message : String(error)}`;
            networkManager.emit();
        } finally {
            setBusy(false);
        }
    }

    function clearLogs() {
        networkManager.clearLogs();
    }

    return (
        <PageShell title="Network Monitoring" route={route} setRoute={setRoute} leftChildren={
            <div className="navBox">
                <h3>Controls</h3>
                <button id="networkToggle" className="full" type="button" disabled={busy} onClick={toggleCapture}>
                    {state.isCapturing ? '⏹ Stop Capture' : '▶ Start Capture'}
                </button>
                <button id="clearNetworkLogs" className="full" type="button" onClick={clearLogs}>Clear Logs</button>
                <div id="networkStatus" className={state.isCapturing ? 'statusCapturing' : state.status?.startsWith('Error') ? 'statusError' : 'statusIdle'}>
                    {state.status}
                </div>
            </div>
        }>
            <div className="networkOverseer">
                <div className="overseerGraphic">
                    <img src={eye} alt="Overseer Eye" className="overseerEye" />

                    <div className="overseerDiagram">
                        <div className="binaryTunnel horizontalTunnel leftTunnel">
                            <BinaryStream />
                        </div>
                        <div className="binaryTunnel horizontalTunnel rightTunnel">
                            <BinaryStream reverse />
                        </div>
                        <div className="binaryTunnel verticalTunnel">
                            <BinaryStream vertical />
                        </div>

                        <div className="redBox logBox userTrafficBox">
                            <div className="logBoxHeader">User Traffic Log</div>
                            <div className="logBoxContent">
                                <div className="logPlaceholder">unused / empty</div>
                            </div>
                        </div>

                        <div className="redBox parserBox">
                            <div className="parserBoxHeader">Parser</div>
                            <div className="parserCore">
                                <BinaryStream />
                            </div>
                        </div>

                        <div className="redBox logBox fullPacketBox">
                            <div className="logBoxHeader">Full Packet Capture</div>
                            <div id="fullPacketCaptureLog" className="logBoxContent" ref={logBoxRef}>
                                {state.logs.length === 0 ? (
                                    <div className="logPlaceholder">
                                        {state.isCapturing ? 'Capturing... waiting for packets.' : 'No packets yet. Click Start Capture.'}
                                    </div>
                                ) : (
                                    state.logs.map((line, index) => (
                                        <div className="logLine" key={`${line}-${index}`}>{line}</div>
                                    ))
                                )}
                            </div>
                        </div>

                        <div className="redBox logBox parserLogsBox">
                            <div className="logBoxHeader">parser logs for fun</div>
                            <div className="logBoxContent parserLogContent" ref={parserLogsRef}>
                                {state.latestPacket ? (
                                    <PacketTransform entry={state.latestPacket} />
                                ) : (
                                    <div className="logPlaceholder">
                                        {state.isCapturing ? 'Parser waiting for binary stream.' : 'No parsed packets yet. Start Full Packet Capture.'}
                                    </div>
                                )}

                                {state.parserLogs.length > 0 && (
                                    <div className="parserHistory">
                                        <div className="historyLabel">recent parser logs</div>
                                        {state.parserLogs.slice(-5).map((entry) => (
                                            <div className="parserHistoryEntry" key={entry.id}>
                                                <span>{entry.packet.summary || entry.packet.protocol}</span>
                                                <code>{entry.binary}</code>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <img src={hand} alt="Left hand" className="overseerHand left" />
                    <img src={hand} alt="Right hand" className="overseerHand right" />
                </div>
            </div>
        </PageShell>
    );
}
