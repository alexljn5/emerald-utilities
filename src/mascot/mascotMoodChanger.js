const dashboardMascot = document.getElementById("dashboardMascot");

const dashboardMascotMoods = {
    dashboardMascotNeutral: "../img/mascot/dashboardMascotNeutral.png",
    dashboardMascotHappy: "../img/mascot/dashboardMascotHappy.png",
    dashboardMascotNervous: "../img/mascot/dashboardMascotNervous.png",
    dashboardMascotAngry: "../img/mascot/dashboardMascotAngry.png",
    dashboardMascotBlushing: "../img/mascot/dashboardMascotBlushing.png",
    dashboardMascotManic: "../img/mascot/dashboardMascotManic.png"
};

let logSpamCounter = 0;
let lastLogTime = Date.now();

function setMascotMood(moodKey) {
    if (dashboardMascot && dashboardMascotMoods[moodKey]) {
        dashboardMascot.src = dashboardMascotMoods[moodKey];
    }
}

function reactToDashboardLog() {
    const now = Date.now();
    if (now - lastLogTime < 300) {
        logSpamCounter++;
    } else {
        logSpamCounter = 0;
    }
    lastLogTime = now;

    if (logSpamCounter > 12) {
        setMascotMood('dashboardMascotManic');
    } else if (logSpamCounter > 5) {
        setMascotMood('dashboardMascotNervous');
    }
}

window.dashboardMascotReactToLog = reactToDashboardLog;
window.addEventListener('emerald-script-log', reactToDashboardLog);

setInterval(() => {
    if (logSpamCounter > 0) logSpamCounter--;
    if (logSpamCounter === 0) {
        setMascotMood('dashboardMascotNeutral');
    }
}, 4000);
