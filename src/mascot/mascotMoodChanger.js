const dashboardMascot = document.getElementById("dashboardMascot");

const dashboardMascotMoods = {
    dashboardMascotNeutral: "../img/mascot/dashboardMascotNeutral.png",
    dashboardMascotHappy: "../img/mascot/dashboardMascotHappy.png",
    dashboardMascotNervous: "../img/mascot/dashboardMascotNervous.png"
};

function setMascotMood(dashboardMascotMood) {
    dashboardMascot.src = dashboardMascotMoods[dashboardMascotMood];
}

setTimeout(() => {
    setMascotMood("dashboardMascotNervous");
}, 1000);