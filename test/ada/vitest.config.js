import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
class IncidentOrder extends BaseSequencer {
  sort(files) { return files.sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default defineConfig({ test: {
  reporters: ['dot'],
  include: ['test/ada/*.test.js'], globalSetup: ['test/ada/global-setup.js'],
  sequence: { sequencer: IncidentOrder }, fileParallelism: false, testTimeout: 180000, hookTimeout: 60000,
} });
