FROM python:3.12-slim

WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
COPY config.toml docker-entrypoint.sh ./
# Runtime dependencies only (no [dev]). The app runs from /srv (config.toml and the static page live there).
RUN pip install --no-cache-dir . \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin ocr \
 && mkdir -p /data/out /data/cache && chown -R ocr:ocr /data \
 && chmod +x docker-entrypoint.sh

ENV OUT_DIR=/data/out CACHE_DIR=/data/cache PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"

# Starts as root only to hand a freshly bind-mounted /data to the app user, then runs as uid 10001.
ENTRYPOINT ["/srv/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
