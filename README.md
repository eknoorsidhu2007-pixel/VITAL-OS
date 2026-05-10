# VITAL OS

> Speech-first clinical support.
> Browser microphone -> Groq (Llama) -> browser speaker.

## Setup

1. Get a Groq key: https://console.groq.com/keys
2. Put it in `.env.local`:

```env
GROQ_API_KEY=your_key_here
```

3. Restart dev server:

```bash
npm run dev
```

## Notes

- Uses browser SpeechRecognition for STT and browser SpeechSynthesis for TTS.
- `/api/vital` calls Groq chat completions.
- Patient roster is persisted in `data/patients.json`.
