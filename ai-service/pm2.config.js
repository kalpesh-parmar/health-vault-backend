module.exports = {
  apps: [
    {
      name: "health-vault-ai-service",
      script: "uvicorn",
      args: "app.main:app --host 0.0.0.0 --port 8000 --workers 4",
      // interpreter points to python inside virtual env.
      // Change to './venv/Scripts/python.exe' if running on a Windows server.
      interpreter: "./venv/bin/python",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        WORKER_MODE: "standalone",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2_error.log",
      out_file: "./logs/pm2_out.log",
      combine_logs: true,
    },
    {
      name: "health-vault-ai-worker",
      script: "-m",
      args: "app.workers.worker",
      interpreter: "./venv/bin/python",
      cwd: "./",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
        WORKER_MODE: "standalone",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2_worker_error.log",
      out_file: "./logs/pm2_worker_out.log",
      combine_logs: true,
    },
  ],
};
