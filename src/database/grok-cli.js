/**
 * Grok CLI Integration
 * Provides interface to xAI Grok CLI for the AI page
 * 
 * Usage: node src/database/grok-cli.js "your message"
 */

import { spawn } from 'child_process';

/**
 * Run Grok CLI with a message
 */
async function queryGrok(message) {
    return new Promise((resolve, reject) => {
        const grokPath = process.env.GROK_PATH ||
            (process.platform === 'win32' ?
                `${process.env.USERPROFILE}\\.grok\\bin\\grok.exe` :
                `${process.env.HOME}/.grok/bin/grok`);

        const child = spawn(grokPath, [message], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });

        let output = '';
        let error = '';

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            error += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true, response: output.trim() });
            } else {
                reject(new Error(`Grok CLI exited with code ${code}: ${error}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Failed to run Grok CLI: ${err.message}`));
        });
    });
}

/**
 * Main function
 */
async function main() {
    const message = process.argv.slice(2).join(' ');

    if (!message) {
        console.log('Usage: node src/database/grok-cli.js "your message"');
        process.exit(1);
    }

    try {
        const result = await queryGrok(message);
        console.log(result.response);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { queryGrok };