// Build hygiene: tsc never deletes stale outputs, so a file removed from the
// emit (e.g. the dropped .d.ts declarations) would otherwise ship forever.
import { rmSync } from 'node:fs';
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
