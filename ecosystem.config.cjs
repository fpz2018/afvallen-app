module.exports = {
  apps: [
    {
      name: 'weight-loss-app',
      script: 'npx',
      args: 'vite --host 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        SUPABASE_URL: 'https://iswjoqoygbptgbednmhf.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlzd2pvcW95Z2JwdGdiZWRubWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzY2NjksImV4cCI6MjA4ODcxMjY2OX0.2KQB0xMRAikvhVCu-Uc8hyNWFtta7imguxZELaJ0jus'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
