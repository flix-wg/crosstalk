import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globalSetup: ['test/ada/global-setup.js'] } });
