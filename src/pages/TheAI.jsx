import PageShell from './PageShell.jsx';
import aiHanging from '../../img/the-ai/the-ai-hanging.png';
import '../css/the-ai.css';

export default function TheAI({ route, setRoute }) {
    return (
        <PageShell title="AI" route={route} setRoute={setRoute}>
            <div className="aiChamber">
                <div className="aiPresence">
                    <img className="aiHanging" src={aiHanging} alt="The AI hanging" />
                    <p className="aiQuestion">Are you really here?</p>
                </div>
            </div>
        </PageShell>
    );
}
