// Cream's silly prank script 🐰
// Slowly logs "SNIIIIFFFFFFF, marleys feet...." and then sniffs randomly!

function slowTypeMessage(message, delay = 150, callback) {
    let index = 0;
    const interval = setInterval(() => {
        if (index < message.length) {
            const nextChar = message.charAt(index);
            console.log(nextChar);
            index++;
        } else {
            clearInterval(interval);
            if (callback) callback();
        }
    }, delay);
}

function startSniffLoop() {
    setInterval(() => {
        const shouldSniff = Math.random() < 0.6;
        if (shouldSniff) {
            const sniffIntensity = Math.random();
            if (sniffIntensity < 0.3) {
                console.log("sniff");
            } else if (sniffIntensity < 0.7) {
                console.log("SNIFF sniff...");
            } else {
                console.log("*aggressive sniffing* 👃💨");
            }
        }
    }, Math.random() * 1500 + 500); // random interval between 500ms–2000ms
}

const funnyMessage = "SNIIIIFFFFFFF, marleys feet....";

slowTypeMessage(funnyMessage, 200, () => {
    console.log("(sniffing intensifies)");
    startSniffLoop();
});
