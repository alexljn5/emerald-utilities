import logo from '../../img/favicons/favicon.png';
import { versionNumber } from '../globals.js';

export default function PageShell({
    title,
    children,
    leftChildren,
    showBack = true,
    route,
    setRoute
}) {
    return (
        <main className="app">
            <aside className="leftPanel">
                <div id="friedEggs" className="headerBlock">
                    <h1>{title}</h1>
                    <span id="versionDisplay" className="versionDisplay">v{versionNumber}</span>
                    <div id="logo">
                        <img src={logo} alt="Logo" width="64" height="64" />
                    </div>
                </div>

                {showBack ? (
                    <button type="button" onClick={() => setRoute('dashboard')}>← Back</button>
                ) : null}

                {leftChildren}
            </aside>

            <section className="rightPanel">{children}</section>
        </main>
    );
}
