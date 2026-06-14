import { useEffect, useRef, useState } from 'react';
import PageShell from './PageShell.jsx';
import { networkManager } from '../core/networkManager.js';
import eye from '../../img/network-overseer/network-overseer-eye.png';
import hand from '../../img/network-overseer/network-overseer-hand.png';
import '../css/network-monitoring.css';

export default function NetworkMonitoring({ route, setRoute }) {
    const [state, setState] = useState({
        isCapturing: networkManager.state.isCapturing,
        logs: [...networkManager.state.logs],
        status: networkManager.state.status
    });
    const [busy, setBusy] = useState(false);
    const logBoxRef = useRef(null);

    useEffect(() => {
        return networkManager.onStateChange((nextState) => {
            setState({
                isCapturing: nextState.isCapturing,
                logs: [...nextState.logs],
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
    }, [state.logs]);

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
                <div id="networkStatus" className={state.isCapturing ? 'statusCapturing' : state.status.startsWith('Error') ? 'statusError' : 'statusIdle'}>
                    {state.status}
                </div>
            </div>
        }>
            <div className="networkOverseer">
                <div className="overseerGraphic">
                    <img src={eye} alt="Overseer Eye" className="overseerEye" />

                    <div className="overseerBoxes">
                        <div className="redBox logBox">
                            <div className="logBoxHeader">User Traffic Log</div>
                            <div className="logBoxContent">
                                <div className="logPlaceholder">TODO: Server connection</div>
                            </div>
                        </div>

                        <div className="redBox logBox">
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
                    </div>

                    <img src={hand} alt="Left hand" className="overseerHand left" />
                    <img src={hand} alt="Right hand" className="overseerHand right" />
                </div>
            </div>
        </PageShell>
    );
}
