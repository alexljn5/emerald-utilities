const dashboardMascot = document.getElementById("dashboardMascot");

// If the mascot element doesn't exist (e.g. not pushed to prod due to copyright),
// exit early — no mascot, no errors.
if (!dashboardMascot) {
    window.dashboardMascotReactToLog = function () { };
} else {
    // Hide mascot gracefully if any image fails to load (e.g. files not present)
    dashboardMascot.addEventListener("error", function handleMascotError() {
        dashboardMascot.style.display = "none";
        dashboardMascot.removeEventListener("error", handleMascotError);
    });

    const dashboardMascotMoods = {
        dashboardMascotNeutral: "../img/mascot/dashboardMascotNeutral.png",
        dashboardMascotHappy: "../img/mascot/dashboardMascotHappy.png",
        dashboardMascotNervous: "../img/mascot/dashboardMascotNervous.png",
        dashboardMascotAngry: "../img/mascot/dashboardMascotAngry.png",
        dashboardMascotBlushing: "../img/mascot/dashboardMascotBlushing.png",
        dashboardMascotManic: "../img/mascot/dashboardMascotManic.png"
    };

    let logSpamCounter = 0;
    let recentLogTimes = [];
    let calmTimer = null;
    const SPAM_WINDOW_MS = 5000;
    const NERVOUS_LINE_THRESHOLD = 10;
    const MANIC_LINE_THRESHOLD = 25;

    function setMascotMood(moodKey) {
        if (dashboardMascot && dashboardMascotMoods[moodKey]) {
            dashboardMascot.src = dashboardMascotMoods[moodKey];
        }
    }

    function pruneOldLogs() {
        const now = Date.now();
        recentLogTimes = recentLogTimes.filter(time => now - time < SPAM_WINDOW_MS);
        logSpamCounter = recentLogTimes.length;
    }

    function reactToDashboardLog() {
        const now = Date.now();
        recentLogTimes.push(now);
        pruneOldLogs();

        if (logSpamCounter >= MANIC_LINE_THRESHOLD) {
            setMascotMood('dashboardMascotManic');
        } else if (logSpamCounter >= NERVOUS_LINE_THRESHOLD) {
            setMascotMood('dashboardMascotNervous');
        }

        clearTimeout(calmTimer);
        calmTimer = setTimeout(() => {
            logSpamCounter = 0;
            recentLogTimes = [];
            setMascotMood('dashboardMascotNeutral');
        }, 3000);
    }

    window.dashboardMascotReactToLog = reactToDashboardLog;
    window.addEventListener('emerald-script-log', reactToDashboardLog);
}
