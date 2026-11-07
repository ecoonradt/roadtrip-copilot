import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === 'dist' || file === 'dist-server') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results.push(...findFiles(fullPath, extensions));
    } else if (extensions.some((ext) => file.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Architectural Boundary Discipline', () => {
  const rootDir = path.resolve(__dirname, '..');
  const srcDir = path.resolve(rootDir, 'src');
  const serverDir = path.resolve(rootDir, 'server');
  const testsDir = path.resolve(rootDir, 'tests');

  it('prohibits root tests directory in route-builder in favor of colocation', () => {
    expect(fs.existsSync(testsDir)).toBe(false);
  });

  it('guarantees frontend (src/) has zero imports from backend (server/)', () => {
    const srcFiles = findFiles(srcDir, ['.ts', '.tsx']);
    expect(srcFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const importRegex = /(?:import|export)\s+.*?\s+from\s+['"](.*?)['"]/g;

    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath.includes('/server/') || importPath.endsWith('/server') || importPath.startsWith('../server')) {
          violations.push(`${path.relative(rootDir, file)}: imports "${importPath}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('guarantees backend (server/) has zero imports from frontend (src/)', () => {
    const serverFiles = findFiles(serverDir, ['.ts', '.tsx']);
    expect(serverFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const importRegex = /(?:import|export)\s+.*?\s+from\s+['"](.*?)['"]/g;

    for (const file of serverFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath.includes('/src/') || importPath.endsWith('/src') || importPath.startsWith('../src')) {
          violations.push(`${path.relative(rootDir, file)}: imports "${importPath}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
