const { getRandomImage } = require('./imagefetcher');

const CHARACTER_CONFIG = {
    cream: {
        query: 'cream the rabbit sonic',
        title: 'Cream The Rabbit',
        color: '#ff0002',
        emoji: 'serveradmin'
    },
    big: {
        query: 'big the cat sonic',
        title: 'Big the Cat',
        color: '#7A4FBF',
        emoji: 'big'
    },
    rouge: {
        query: 'rouge the bat sonic',
        title: 'Rouge the Bat',
        color: '#FFD700',
        emoji: 'rouge'
    },
    sonic: {
        query: 'sonic the hedgehog',
        title: 'Sonic the Hedgehog',
        color: '#0066CC',
        emoji: 'sonic'
    },
    metal: {
        query: 'metal sonic',
        title: 'Metal Sonic',
        color: '#A9A9A9',
        emoji: 'metalsonic'
    },
    neometal: {
        query: 'neo metal sonic',
        title: 'Neo Metal Sonic',
        color: '#696969',
        emoji: 'neometalsonic'
    },
    amy: {
        query: 'amy rose sonic',
        title: 'Amy Rose',
        color: '#FF69B4',
        emoji: 'amy'
    },
    tails: {
        query: 'tails the fox miles prower',
        title: 'Tails The Fox',
        color: '#FFA500',
        emoji: 'tails'
    },
    sonicexe: {
        query: 'sonic.exe creepypasta',
        title: 'Sonic.EXE',
        color: '#8B0000',
        emoji: 'sonicexe'
    }
};

async function getCharacterImage(type) {
    const config = CHARACTER_CONFIG[type];

    if (!config) {
        throw new Error(`Unknown character: ${type}`);
    }

    const img = await getRandomImage({
        query: config.query
    });

    return { img, config };
}

module.exports = { getCharacterImage, CHARACTER_CONFIG };