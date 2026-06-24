import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('admin hidden styling', () => {
  it('preserves the hidden attribute on admin surfaces', () => {
    const css = fs.readFileSync(new URL('../public/css/admin.css', import.meta.url), 'utf8');
    expect(css).toContain('[hidden] { display: none !important; }');
  });
});
