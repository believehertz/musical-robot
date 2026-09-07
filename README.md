# musical-robot

SongVault is a local music search and download application.

## Run locally

```powershell
npm install
npm start
```

Open http://localhost:3000.

The download fallback uses `yt-dlp`. On Windows, install it in the project
virtual environment at `.venv\Scripts\yt-dlp.exe`.

## Deploy to Vercel

The API runs as a Vercel function. Set `SONGVAULT_API_KEY` in the Vercel
project environment variables before using the deployed app. Vercel storage
is temporary, so completed-download history is not durable across function
instances.