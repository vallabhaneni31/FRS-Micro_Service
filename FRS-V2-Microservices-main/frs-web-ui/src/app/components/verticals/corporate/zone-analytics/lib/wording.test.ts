// specs/0003-zone-analytics — Req 11.1/11.2, design.md 4 (test row 11.1-11.3):
// a whole-word scan of every USER-VISIBLE string literal in the zone-analytics
// component files (JSX text, string/template literals, JSX string attributes)
// for engineer/device/attendance/capacity jargon. Tests and fixtures are excluded.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { KPI_COPY } from './copy';

const ROOT = path.resolve(__dirname, '..');
const BANNED = ['Portal', 'Turnstile', 'telemetry', 'Optical', 'SLA', 'cosine', 'Scanalitix', 'Cap', 'Shift', 'Overtime'];
const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');

// Attribute / property names whose string values are not shown to the user.
const NON_VISIBLE_ATTRS = new Set(['className', 'id', 'key', 'data-testid', 'type', 'role', 'htmlFor', 'name', 'fill', 'stroke', 'dataKey', 'stackId', 'strokeDasharray', 'href', 'viewBox', 'd', 'width', 'height', 'points', 'stopColor']);

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listSourceFiles(p);
    if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name) || /fixtures?/i.test(e.name)) return [];
    return [p];
  });
}

/** Every user-visible string literal in a source file. */
export function visibleStrings(source: string, fileName = 'x.tsx'): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      const t = node.getText(sf).trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const isAttr = ts.isJsxAttribute(parent) && NON_VISIBLE_ATTRS.has(parent.name.getText(sf));
      const isKey = ts.isPropertyAssignment(parent) && parent.name === node;
      const isInitOfClass = ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) && NON_VISIBLE_ATTRS.has(parent.parent.name.getText(sf));
      const isCallToCn = ts.isCallExpression(parent) && /^(cn|clsx)$/.test(parent.expression.getText(sf));
      const isTypeLiteral = ts.isLiteralTypeNode(parent);
      const isCase = ts.isCaseClause(parent);
      if (!isAttr && !isKey && !isInitOfClass && !isCallToCn && !isTypeLiteral && !isCase) out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.filter((s) => s.trim().length > 0);
}

describe('HR wording (Req 11.1)', () => {
  it('finds banned words when they are present (the scanner itself works)', () => {
    const src = `const a = <div title="ok">Net Portal Flow</div>; const b = 'Standard Shift'; const c = <p className="Cap">fine</p>;`;
    const hits = visibleStrings(src).filter((s) => BANNED_RE.test(s));
    expect(hits).toEqual(['Net Portal Flow', 'Standard Shift']);
  });

  it('does not treat class names, ids or imports as visible text', () => {
    const src = `import x from './Portal'; const a = <div id="portal-root" className="Cap Shift" data-testid="turnstile">Hello</div>;`;
    expect(visibleStrings(src).filter((s) => BANNED_RE.test(s))).toEqual([]);
  });

  const files = listSourceFiles(ROOT);
  it('scans a non-trivial set of component files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))('%s has no banned whole words in user-visible strings', (_rel, file) => {
    const src = fs.readFileSync(file as string, 'utf8');
    const hits = visibleStrings(src, file as string).filter((s) => BANNED_RE.test(s));
    expect(hits).toEqual([]);
  });
});

describe('every KPI / summary tile has a plain-language description (Req 11.2)', () => {
  it('each KPI_COPY entry has a title and a one-line description', () => {
    for (const [key, v] of Object.entries(KPI_COPY)) {
      expect(v.title.trim().length, key).toBeGreaterThan(2);
      expect(v.description.trim().length, key).toBeGreaterThan(15);
      expect(v.description.includes('\n'), key).toBe(false);
      expect(BANNED_RE.test(v.title + ' ' + v.description), key).toBe(false);
    }
  });

  it('covers the 3 hero cards, 4 stat tiles, 3 peak-hours cards, 4 movement cards and 4 employee tiles', () => {
    const keys = Object.keys(KPI_COPY);
    for (const k of ['headcount', 'flow', 'dwell', 'activeCount', 'highestPeak', 'activeZones', 'camerasOnline', 'highestTraffic', 'lowestTraffic', 'peakMoment', 'trackedEmployees', 'meanTime', 'mostActive', 'meanConfidence', 'timeInZone', 'zoneVisits', 'matchConfidence', 'lastSeen']) {
      expect(keys).toContain(k);
    }
  });
});
