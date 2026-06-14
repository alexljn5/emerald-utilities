import { useEffect, useMemo, useState } from 'react';
import PageShell from './PageShell.jsx';
import { scriptManager } from '../core/scriptManager.js';
import { useTerminalLog } from '../js/terminalHooks.js';
import sigil from '../../img/backgrounds/sigil_1.png';
import neutralMascot from '../../img/mascot/dashboardMascotNeutral.png';
import happyMascot from '../../img/mascot/dashboardMascotHappy.png';
import nervousMascot from '../../img/mascot/dashboardMascotNervous.png';
import angryMascot from '../../img/mascot/dashboardMascotAngry.png';
import blushingMascot from '../../img/mascot/dashboardMascotBlushing.png';
import manicMascot from '../../img/mascot/dashboardMascotManic.png';
import '../css/index.css';

const moods = {
    neutral: neutralMascot,
    happy: happyMascot,
    nervous: nervousMascot,
    angry: angryMascot,
    blushing: blushingMascot,
    manic: manicMascot
};

function TerminalLines({ terminalLog, terminalRef }) {
    const lines = useMemo(() => terminalLog.slice(-500), [terminalLog]);

    return (
        <div id="terminalOutput" className="dashboardTerminal" ref={terminalRef}>
            {lines.length === 0 ? (
                <div className="logPlaceholder">No terminal output yet.</div>
            ) : (
                lines.map((entry, index) => (
                    <div className="logLine" key={`${entry.id ?? index}-${index}`}>
                        {entry.message}
                    </div>
                ))
            )}
        </div>
    );
}

export default function Dashboard({ route, setRoute }) {
    const { terminalLog, appendTerminalLog, terminalRef } = useTerminalLog();
    const [mascotMood, setMascotMood] = useState('neutral');

    useEffect(() => {
        scriptManager.bindLogger(appendTerminalLog);
        scriptManager.init({ bindUI: false, skipAutoRun: false });
        scriptManager.replayMainProcessLogToTerminal(500);

        return () => {
            scriptManager.unbindLogger();
        };
    }, []);

    useEffect(() => {
        const count = terminalLog.length;
        let nextMood = 'neutral';

        if (count >= 25) {
            nextMood = 'manic';
        } else if (count >= 10) {
            nextMood = 'nervous';
        } else if (count >= 1) {
            nextMood = 'happy';
        }

        setMascotMood(nextMood);

        const calmTimer = setTimeout(() => {
            setMascotMood('neutral');
        }, 3000);

        return () => clearTimeout(calmTimer);
    }, [terminalLog]);

    return (
        <PageShell title="Emerald Utilities" route={route} setRoute={setRoute} showBack={false} leftChildren={
            <div className="navBox">
                <h2>Navigation</h2>
                <div className="navButtons">
                    <button className="nav-btn full" type="button" onClick={() => setRoute('scriptTool')}>Script Tool</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('networkMonitoring')}>Network Monitor</button>
                    <button className="nav-btn full" type="button" onClick={() => setRoute('about')}>ⓘ About</button>
                </div>
            </div>
        }>
            <div className="backGroundSigil" aria-hidden="true">
                <img id="backGroundSigil_1" src={sigil} alt="" />
            </div>
            <TerminalLines terminalLog={terminalLog} terminalRef={terminalRef} />
            <div id="dashboardMascotImage">
                <img id="dashboardMascot" src={moods[mascotMood]} alt="Dashboard mascot" />
            </div>
        </PageShell>
    );
}
