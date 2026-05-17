# VITAL OS

> Speech-first clinical support.
> Browser microphone -> Google Gemini -> browser speaker.

## Setup

1. Get a Gemini API key: https://aistudio.google.com/apikey
2. Put it in `.env.local`:

```env
GEMINI_API_KEY=your_key_here
```

3. Restart dev server:

```bash
npm run dev
```

## Notes

- Uses browser SpeechRecognition for STT and browser SpeechSynthesis for TTS.
- `/api/vital` calls Google Gemini (`gemini-1.5-flash`) generateContent.
- Patient roster is persisted in `data/patients.json`.
