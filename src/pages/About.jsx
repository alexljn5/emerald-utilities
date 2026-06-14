import { useState } from 'react';
import PageShell from './PageShell.jsx';
import { versionNumber } from '../js/version.js';
import creepyImage from '../../img/creepy.png';
import '../css/about.css';

export default function About({ route, setRoute }) {
    const [modalOpen, setModalOpen] = useState(false);

    return (
        <PageShell title="About" route={route} setRoute={setRoute} leftChildren={
            <>
                <h3>Navigation</h3>

                <button type="button" onClick={() => setRoute('dashboard')}>Main App</button>

                <div className="aboutCreepyImage">
                    <img src={creepyImage} alt="..." width="512" height="512" />
                </div>
            </>
        }>
            <div className="aboutContent">
                <h2>About Emerald Utilities</h2>

                <h3>How to run SH scripts</h3>
                <p>
                    This tool supports running <code>.sh</code> (bash) scripts inside <strong>WSL</strong>, but due to
                    path differences between Windows and Linux, you need a <strong>.bat helper script</strong>.
                </p>

                <p>
                    <strong>Why?</strong> Windows paths like <code>C:\Users\...</code> are not understood by bash inside
                    WSL. The correct path is <code>/mnt/c/Users/...</code>.
                </p>

                <p>
                    <strong>Solution:</strong> Create a <code>.bat</code> file that calls WSL with the proper path.
                </p>

                <pre><code>@echo off
                    wsl bash /mnt/c/Users/YourName/scripts/myscript.sh</code></pre>

                <p>
                    Then run the <code>.bat</code> file from Emerald Utilities.
                </p>

                <hr />

                <p>Made by alexljn5 for personal system utilities.</p>

                <button id="aboutButton" type="button" onClick={() => setModalOpen(true)}>Open About Modal</button>
            </div>

            {modalOpen ? (
                <div className="modal" role="dialog" aria-modal="true" onClick={() => setModalOpen(false)}>
                    <div className="modal-content" onClick={(event) => event.stopPropagation()}>
                        <span className="close" onClick={() => setModalOpen(false)}>&times;</span>
                        <h2>About Emerald Utilities</h2>
                        <p>Version <span id="modalVersion">v{versionNumber}</span></p>
                        <p>Made by alexljn5 for personal system utilities.</p>
                    </div>
                </div>
            ) : null}
        </PageShell>
    );
}
