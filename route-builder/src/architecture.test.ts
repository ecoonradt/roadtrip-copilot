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

/** Import specifiers, including multiline `import { } from` and `import()`. */
export function collectImportSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of withoutComments.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function crossesBoundary(specifier: string, fromTree: 'src' | 'server'): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('src/') && !specifier.startsWith('server/')) {
    return false;
  }
  const forbidden = fromTree === 'src' ? 'server' : 'src';
  return specifier.split(/[/\\]/).includes(forbidden);
}

function boundaryViolations(files: Array<{ relativePath: string; source: string }>, fromTree: 'src' | 'server'): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of collectImportSpecifiers(file.source)) {
      if (crossesBoundary(specifier, fromTree)) {
        violations.push(`${file.relativePath}: imports "${specifier}"`);
      }
    }
  }
  return violations;
}

describe('Architectural Boundary Discipline', () => {
  const rootDir = path.resolve(__dirname, '..');
  const srcDir = path.resolve(rootDir, 'src');
  const serverDir = path.resolve(rootDir, 'server');
  const testsDir = path.resolve(rootDir, 'tests');

  it('prohibits root tests directory in route-builder in favor of colocation', () => {
    expect(fs.existsSync(testsDir)).toBe(false);
  });

  it('sees multiline and dynamic imports the tree actually writes', () => {
    expect(collectImportSpecifiers("import {\n  foo,\n} from '../server/bar';")).toContain('../server/bar');
    expect(collectImportSpecifiers("await import('../server/foo.js')")).toContain('../server/foo.js');
    expect(collectImportSpecifiers("export { bar } from '../src/engine/cascade';")).toContain('../src/engine/cascade');
    expect(boundaryViolations(
      [{ relativePath: 'src/example.ts', source: "import {\n  foo,\n} from '../server/bar';" }],
      'src',
    )).toEqual(['src/example.ts: imports "../server/bar"']);
    expect(boundaryViolations(
      [{ relativePath: 'src/example.ts', source: "import { foo } from './components/App';" }],
      'src',
    )).toEqual([]);
  });

  it('guarantees frontend (src/) has zero imports from backend (server/)', () => {
    const srcFiles = findFiles(srcDir, ['.ts', '.tsx']).filter((file) => !file.endsWith('architecture.test.ts'));
    expect(srcFiles.length).toBeGreaterThan(0);
    const violations = boundaryViolations(
      srcFiles.map((file) => ({
        relativePath: path.relative(rootDir, file),
        source: fs.readFileSync(file, 'utf-8'),
      })),
      'src',
    );
    expect(violations).toEqual([]);
  });

  it('guarantees backend (server/) has zero imports from frontend (src/)', () => {
    const serverFiles = findFiles(serverDir, ['.ts', '.tsx']);
    expect(serverFiles.length).toBeGreaterThan(0);
    const violations = boundaryViolations(
      serverFiles.map((file) => ({
        relativePath: path.relative(rootDir, file),
        source: fs.readFileSync(file, 'utf-8'),
      })),
      'server',
    );
    expect(violations).toEqual([]);
  });
});
