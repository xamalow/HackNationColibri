# Synthetic data (not real)

Everything in this folder is invented by the team for tests and the offline demo. Every item carries
`"synthetic": true`, phone numbers contain `SYNTH`, and no real person, booking or message is represented.

| File | Used by | What it is | Does not cover |
|---|---|---|---|
| `inbox/w2_demo_week.json` | W2 demo, `tests/test_w2_answer_tourist.py` | 9 tourist messages (en, de, fr, sw; WhatsApp, SMS, GetYourGuide/Airbnb e-mail, missed call), incl. a prompt-injection attempt | Real platform e-mail formats, voicemail audio, Kikuyu, misspellings and slang at scale |
