// Load environment variables from .dev.vars file
const fs = require('fs')
const path = require('path')

const envVars = {}
try {
  const devVars = fs.readFileSync(path.join(__dirname, '.dev.vars'), 'utf8')
  devVars.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=')
    if (key && valueParts.length) {
      envVars[key.trim()] = valueParts.join('=').trim()
    }
  })
} catch(e) { /* .dev.vars not found, use env */ }

module.exports = {
  apps: [
    {
      name: 'weight-loss-app',
      script: 'npx',
      args: 'vite --host 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        ...envVars
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
