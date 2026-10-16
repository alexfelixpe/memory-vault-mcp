import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EmbedClient } from '../../src/embed/client.js';

/**
 * Real ONNX smoke test (worker + e5-small model). Outside the normal flow:
 * runs only with MEMORY_TEST_ONNX=1 and a compiled dist (section 12 of the plan).
 */

const workerPath = fileURLToPath(new URL('../../dist/embed/worker.js', import.meta.url));
const enabled = process.env['MEMORY_TEST_ONNX'] === '1' && fs.existsSync(workerPath);

describe.skipIf(!enabled)('onnx smoke (MEMORY_TEST_ONNX=1)', () => {
  it('warmup + embed with normalized vectors and reasonable semantics', async () => {
    const client = new EmbedClient({ workerPath });
    try {
      await client.warmup();
      expect(client.isWarm()).toBe(true);

      const [q] = await client.embedQueries(['what did we decide about tenant isolation']);
      const [pRelated, pUnrelated] = await client.embedPassages([
        'tenant isolation by a separate schema in Postgres',
        'carrot cake recipe with chocolate frosting',
      ]);
      expect(q!.length).toBe(384);

      const dot = (a: Float32Array, b: Float32Array): number => {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
        return s;
      };
      const norm = Math.sqrt(dot(q!, q!));
      expect(norm).toBeCloseTo(1.0, 2);
      expect(dot(q!, pRelated!)).toBeGreaterThan(dot(q!, pUnrelated!));
    } finally {
      await client.close();
    }
  }, 240_000);
});
