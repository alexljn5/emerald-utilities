import { useState } from 'react';
import PageShell from './PageShell.jsx';
import { versionNumber } from '../globals.js';
import sigilLogo from '../../img/logos/emerald_logo_merge_transparent.png';
import bunnyIcon from '../../img/bunny-icon.png';
import authorAvatar from '../../img/characters/scary-clock.png';
import '../css/about.css';

export default function About({ route, setRoute }) {
    return (
        <PageShell title="About" route={route} setRoute={setRoute} leftChildren={
            <>
                <div className="aboutLogoContainer">
                    <img
                        src={sigilLogo}
                        alt="Emerald Utilities Logo"
                        className="aboutLogo"
                    />
                </div>
            </>
        }>
            <div className="aboutContent">
                <section className="aboutSection developerSection">
                    <h2>Developer</h2>
                    <div className="developerInfo">
                        <img
                            src={authorAvatar}
                            alt="Developer Avatar"
                            className="developerAvatar"
                        />
                        <div className="developerDetails">
                            <p><strong>Author:</strong> emerald-user</p>
                            <p><strong>Purpose:</strong> Personal tools, developer experiments, practical automation.</p>
                        </div>
                    </div>
                </section>

                <section className="aboutSection">
                    <h2>Technical Information</h2>
                    <div className="techGrid">
                        <div className="techCard">
                            <h3>Version</h3>
                            <p className="versionNumber">{versionNumber}</p>
                        </div>
                        <div className="techCard">
                            <h3>Technology</h3>
                            <ul className="techList">
                                <li>Electron</li>
                                <li>React</li>
                                <li>Node.js</li>
                                <li>SQLite</li>
                                <li>Docker</li>
                                <li>AI Integrations</li>
                                <li>External APIs</li>
                            </ul>
                        </div>
                        <div className="techCard">
                            <h3>Modules</h3>
                            <ul className="techList">
                                <li>Script Manager</li>
                                <li>Creator Hub</li>
                                <li>AI Tools</li>
                                <li>Database Tools</li>
                                <li>Network Utilities</li>
                                <li>Mod Updater</li>
                                <li>Portfolio Monitor</li>
                            </ul>
                        </div>
                    </div>
                </section>

                <footer className="aboutFooter">
                    <p>Designed and built by emerald-user</p>
                    <p>Version {versionNumber}</p>
                </footer>
            </div>
        </PageShell>
    );
}
