FROM python:3.11-slim

# Install system dependencies: FFmpeg, ffprobe, curl, ca-certificates, tini (PID 1 init)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency definition
COPY requirements.txt .

# Install Python packages
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend application source
COPY . .

# Expose FastAPI application port
EXPOSE 8000

# Use tini as PID 1 init to reap zombie subprocesses and manage signals
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run FastAPI via Uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
