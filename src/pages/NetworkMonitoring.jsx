import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { networkManager } from '../core/networkManager.js';
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

    const [busy, setBusy] = useState(false);
    const logBoxRef = useRef(null);
    const parserLogsRef = useRef(null);

    useEffect(() => {
        return networkManager.onStateChange((next) => {
            setState({
                isCapturing: next.isCapturing,
                logs: [...(next.logs || [])],
                parserLogs: [...(next.parserLogs || [])],
                latestPacket: next.latestPacket || null,
                status: next.status
            });
        });
    }, []);

    useEffect(() => {
        if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
        if (parserLogsRef.current) parserLogsRef.current.scrollTop = parserLogsRef.current.scrollHeight;
    }, [state.logs, state.parserLogs]);

    async function toggleCapture() {
        if (busy) return;
        setBusy(true);
        try {
            if (state.isCapturing) {
                await networkManager.stopCapture();
            } else {
                await networkManager.startCapture();
            }
        } catch (e) {
            console.error(e);
        } finally {
            setBusy(false);
        }
    }

    function clearLogs() {
        networkManager.clearLogs();
    }

    const latestBinary = state.latestPacket?.binary || "01010101 10101010 11001100";

    return (
        <PageShell title="Network Monitoring" route={route} setRoute={setRoute} leftChildren={
            <div className="navBox">
                <h3>Controls</h3>
                <button className="full" disabled={busy} onClick={toggleCapture}>
                    {state.isCapturing ? '⏹ Stop Capture' : '▶ Start Capture'}
                </button>
                <button className="full" onClick={clearLogs}>Clear Logs</button>
                <div className={state.isCapturing ? 'statusCapturing' : state.status?.startsWith('Error') ? 'statusError' : 'statusIdle'}>
                    {state.status}
                </div>
            </div>
        }>
            <div className="networkOverseer">
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

                        {/* Left box - unused */}
                        <div className="redBox logBox userTrafficBox">
                            <div className="logBoxHeader">User Traffic Log</div>
                            <div className="logBoxContent">
                                <div className="logPlaceholder">unused / empty</div>
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
                            <div className="logBoxHeader">parser logs for fun</div>
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