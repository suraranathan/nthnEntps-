import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.nthnentps.dashboard',
  appName: 'nthnEntps',
  webDir: 'dist',
  // Termux and Android WebView share this phone's loopback network namespace.
  // Vite serves the dashboard here and proxies /api to 127.0.0.1:3001.
  server: { url: 'http://127.0.0.1:3000', cleartext: true },
}

export default config
