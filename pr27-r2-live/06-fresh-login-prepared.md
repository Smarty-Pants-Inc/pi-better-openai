# Prepared: fresh Pi 1.0 "Sign in with ChatGPT" login (NOT started)

Run on Dev1 by the account owner (about 5 min), in an isolated agent dir so the fleet's ~/.pi/agent is untouched:

    ssh -L 1455:localhost:1455 dev1          # forwards Pi's OAuth callback port (REDIRECT http://localhost:1455/auth/callback)
    D=$(mktemp -d); chmod 700 "$D"; cd /tmp/factory-repair-mvVR/pbolive.Ushz/p27
    PI_CODING_AGENT_DIR="$D" PI_SKIP_VERSION_CHECK=1 ./node_modules/.bin/pi -ne -e ./index.ts --no-session

Clicks:
1. In Pi type `/login openai` and choose **Sign in with ChatGPT** (provider "OpenAI (ChatGPT subscription)").
2. Open the URL Pi prints in your own browser, sign in to the ChatGPT account and approve access.
3. The browser lands on localhost:1455 (forwarded) and Pi says it is logged in. If the callback does not arrive,
   copy the final redirect URL from the browser address bar and paste it into Pi's prompt.
4. Then run: `/model` -> pick an `openai/...` subscription model; `/openai-usage`;
   `/openai-image a small red apple on a white table`; `/openai-websearch current UTC date`; `/pets wake <slug>`.
5. To finish: `/logout openai`, then delete the "$D" directory. Never paste a token, code or redirect URL into chat or a PR.
