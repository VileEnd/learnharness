# Claude Code CLI behind a small TCP runner (runner.mjs). The app talks to the
# runner only; the CLI's login lives in /claude (a volume), never in the app.
FROM node:26-slim
RUN npm i -g @anthropic-ai/claude-code@2.1.301 && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=/claude HOME=/home/node
WORKDIR /app
COPY runner.mjs /app/runner.mjs
USER node
CMD ["node","/app/runner.mjs"]
