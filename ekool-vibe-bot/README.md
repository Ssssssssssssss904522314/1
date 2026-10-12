# EKOOOL Vibe

Telegram group companion bot powered by Groq.

## Render
Create a Background Worker from this repository. Set Root Directory to `ekool-vibe-bot`, Build Command to `npm install`, and Start Command to `npm start`.

Environment variables: `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY`; optional `GROQ_MODEL` (default `openai/gpt-oss-20b`), `ALLOWED_CHAT_IDS` (comma-separated IDs), and `SPONTANEOUS_COOLDOWN_SECONDS` (default 3600).

## Telegram
Add the bot to the group. In @BotFather use `/setprivacy`, select the bot, choose Disable, then remove and re-add the bot to the group. The bot needs permission to send messages.

Context is kept in memory and cleared when the worker restarts. Never commit real tokens or API keys.
