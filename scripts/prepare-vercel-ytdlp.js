'use strict';

const fs = require('fs');
const path = require('path');

const packageDir = path.join(__dirname, '..', 'node_modules', 'youtube-dl-exec');
const binaryPath = path.join(packageDir, 'bin', 'yt-dlp');
const apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

async function main() {
    const headers = { 'User-Agent': 'SongVault-Vercel-Build' };
    const releaseResponse = await fetch(apiUrl, { headers });
    if (!releaseResponse.ok) {
        throw new Error(`Could not fetch yt-dlp release metadata: ${releaseResponse.status}`);
    }

    const release = await releaseResponse.json();
    const asset = release.assets?.find(item => item.name === 'yt-dlp_linux');
    if (!asset?.browser_download_url) {
        throw new Error('The latest yt-dlp release has no yt-dlp_linux asset');
    }

    const binaryResponse = await fetch(asset.browser_download_url, { headers });
    if (!binaryResponse.ok || !binaryResponse.body) {
        throw new Error(`Could not download yt-dlp_linux: ${binaryResponse.status}`);
    }

    const binary = Buffer.from(await binaryResponse.arrayBuffer());
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, binary);
    fs.chmodSync(binaryPath, 0o755);
    console.log(`Prepared native yt-dlp binary: ${binaryPath} (${binary.length} bytes)`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
