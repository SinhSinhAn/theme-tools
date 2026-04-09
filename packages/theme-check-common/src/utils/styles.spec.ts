import { expect, describe, it } from 'vitest';
import { toLiquidHtmlAST, NodeTypes } from '@shopify/liquid-html-parser';
import {
  extractCSSClassNames,
  extractCSSClassesFromLiquidUri,
  extractCSSClassesFromAssetUri,
  extractCSSClassesFromAssets,
  extractAllThemeCSSClasses,
  collectUsedClasses,
} from './styles';
import { MockFileSystem } from '../test/MockFileSystem';

describe('extractCSSClassNames', () => {
  it('extracts simple class selectors', () => {
    const classes = extractCSSClassNames('.my-class { color: red; }');
    expect(classes).toEqual(new Set(['my-class']));
  });

  it('extracts multiple classes from a single rule', () => {
    const classes = extractCSSClassNames('.a .b { color: red; }');
    expect(classes).toEqual(new Set(['a', 'b']));
  });

  it('extracts classes from comma-separated selectors', () => {
    const classes = extractCSSClassNames('.a, .b { color: red; }');
    expect(classes).toEqual(new Set(['a', 'b']));
  });

  it('extracts classes from complex selectors', () => {
    const classes = extractCSSClassNames('.parent > .child + .sibling ~ .cousin { color: red; }');
    expect(classes).toEqual(new Set(['parent', 'child', 'sibling', 'cousin']));
  });

  it('extracts classes from pseudo-class selectors', () => {
    const classes = extractCSSClassNames('.btn:hover { color: red; } .link::before { content: ""; }');
    expect(classes).toEqual(new Set(['btn', 'link']));
  });

  it('extracts classes inside media queries', () => {
    const classes = extractCSSClassNames('@media (min-width: 768px) { .responsive { display: block; } }');
    expect(classes).toEqual(new Set(['responsive']));
  });

  it('ignores classes inside CSS comments', () => {
    const classes = extractCSSClassNames('/* .commented-out { color: red; } */ .real { color: blue; }');
    expect(classes).toEqual(new Set(['real']));
  });

  it('returns empty set for invalid CSS', () => {
    const classes = extractCSSClassNames('this is {{ not }} valid css {{{');
    expect(classes.size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    const classes = extractCSSClassNames('');
    expect(classes.size).toBe(0);
  });

  it('handles classes with hyphens and underscores', () => {
    const classes = extractCSSClassNames('.my-class_name { color: red; } ._private { color: blue; }');
    expect(classes).toEqual(new Set(['my-class_name', '_private']));
  });

  it('handles compound class selectors', () => {
    const classes = extractCSSClassNames('.a.b { color: red; }');
    expect(classes).toEqual(new Set(['a', 'b']));
  });
});

describe('collectUsedClasses', () => {
  function parseAttributes(html: string) {
    const ast = toLiquidHtmlAST(html);
    if (ast instanceof Error) throw ast;
    const node = ast.children[0];
    if (!('attributes' in node)) throw new Error('Expected HTML element');
    return node.attributes;
  }

  it('extracts class names from a simple class attribute', () => {
    const attrs = parseAttributes('<div class="a b c"></div>');
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];
    collectUsedClasses(attrs, usedClasses);
    expect(usedClasses.map((c) => c.className)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for elements without class attribute', () => {
    const attrs = parseAttributes('<div id="test"></div>');
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];
    collectUsedClasses(attrs, usedClasses);
    expect(usedClasses).toHaveLength(0);
  });

  it('returns empty for empty class attribute', () => {
    const attrs = parseAttributes('<div class=""></div>');
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];
    collectUsedClasses(attrs, usedClasses);
    expect(usedClasses).toHaveLength(0);
  });

  it('skips dynamic Liquid values', () => {
    const attrs = parseAttributes('<div class="static {{ dynamic }}"></div>');
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];
    collectUsedClasses(attrs, usedClasses);
    expect(usedClasses.map((c) => c.className)).toEqual(['static']);
  });

  it('tracks correct start and end positions', () => {
    const html = '<div class="foo bar"></div>';
    const attrs = parseAttributes(html);
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];
    collectUsedClasses(attrs, usedClasses);
    expect(html.slice(usedClasses[0].startIndex, usedClasses[0].endIndex)).toBe('foo');
    expect(html.slice(usedClasses[1].startIndex, usedClasses[1].endIndex)).toBe('bar');
  });
});

describe('extractCSSClassesFromLiquidUri', () => {
  it('extracts classes from stylesheet tags in a liquid file', async () => {
    const fs = new MockFileSystem({
      'snippets/styles.liquid': `
        {% stylesheet %}
          .snippet-class { color: red; }
          .another { color: blue; }
        {% endstylesheet %}
      `,
    });
    const classes = await extractCSSClassesFromLiquidUri('file:///snippets/styles.liquid', fs);
    expect(classes).toEqual(new Set(['snippet-class', 'another']));
  });

  it('returns empty set for file without stylesheet tags', async () => {
    const fs = new MockFileSystem({
      'snippets/plain.liquid': '<div>Hello</div>',
    });
    const classes = await extractCSSClassesFromLiquidUri('file:///snippets/plain.liquid', fs);
    expect(classes.size).toBe(0);
  });

  it('returns empty set for missing file', async () => {
    const fs = new MockFileSystem({});
    const classes = await extractCSSClassesFromLiquidUri('file:///missing.liquid', fs);
    expect(classes.size).toBe(0);
  });
});

describe('extractCSSClassesFromAssetUri', () => {
  it('extracts classes from a CSS file', async () => {
    const fs = new MockFileSystem({
      'assets/theme.css': '.asset-class { color: red; } .other { color: blue; }',
    });
    const classes = await extractCSSClassesFromAssetUri('file:///assets/theme.css', fs);
    expect(classes).toEqual(new Set(['asset-class', 'other']));
  });

  it('returns empty set for missing file', async () => {
    const fs = new MockFileSystem({});
    const classes = await extractCSSClassesFromAssetUri('file:///missing.css', fs);
    expect(classes.size).toBe(0);
  });
});

describe('extractCSSClassesFromAssets', () => {
  it('collects classes from all .css files in assets', async () => {
    const fs = new MockFileSystem({
      'assets/base.css': '.base { color: red; }',
      'assets/theme.css': '.theme { color: blue; }',
      'assets/app.js': 'console.log("not css")',
    });
    const toUri = (rel: string) => `file:///${rel}`;
    const classes = await extractCSSClassesFromAssets(fs, toUri);
    expect(classes).toEqual(new Set(['base', 'theme']));
  });

  it('returns empty set when assets directory does not exist', async () => {
    const fs = new MockFileSystem({});
    const toUri = (rel: string) => `file:///${rel}`;
    const classes = await extractCSSClassesFromAssets(fs, toUri);
    expect(classes.size).toBe(0);
  });
});

describe('extractAllThemeCSSClasses', () => {
  it('collects classes from both liquid stylesheets and CSS assets', async () => {
    const fs = new MockFileSystem({
      'assets/theme.css': '.asset-class { color: red; }',
      'sections/section.liquid': '{% stylesheet %} .section-class { color: blue; } {% endstylesheet %}',
      'snippets/snippet.liquid': '{% stylesheet %} .snippet-class { font-size: 14px; } {% endstylesheet %}',
    });
    const toUri = (rel: string) => `file:///${rel}`;
    const classes = await extractAllThemeCSSClasses(fs, toUri);
    expect(classes).toEqual(new Set(['asset-class', 'section-class', 'snippet-class']));
  });

  it('returns empty set for empty theme', async () => {
    const fs = new MockFileSystem({});
    const toUri = (rel: string) => `file:///${rel}`;
    const classes = await extractAllThemeCSSClasses(fs, toUri);
    expect(classes.size).toBe(0);
  });
});
