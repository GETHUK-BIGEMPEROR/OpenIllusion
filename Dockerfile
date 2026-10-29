# OpenIllusion in a container. The app only; ComfyUI and its models stay on the host (or wherever
# OPENILLUSION_COMFYUI_URL points). See README → Setup → Docker.

# 1 · the web app
FROM node:20-slim AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# 2 · the server, which serves the web app from server/static
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    OPENILLUSION_HOME=/data \
    OPENILLUSION_COMFYUI_URL=http://host.docker.internal:8188
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY server/ server/
COPY templates/ templates/
COPY schema/ schema/
COPY --from=ui /src/server/static/ server/static/
# Editable: the server finds templates/ next to its own folder.
RUN pip install -e . \
 && useradd --create-home --uid 1000 openillusion \
 && mkdir -p /data && chown openillusion /data
USER openillusion
VOLUME /data
EXPOSE 7870
# 0.0.0.0 inside the container only; compose publishes it on the host's 127.0.0.1.
CMD ["python", "-m", "server", "--host", "0.0.0.0", "--port", "7870"]
