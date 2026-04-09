import {
  NodeTypes,
  TextNode,
  LiquidRawTag,
  toLiquidHtmlAST,
  AttributeNode,
} from '@shopify/liquid-html-parser';
import postcss from 'postcss';
import { SourceCodeType } from '../types';
import { AbstractFileSystem } from '../AbstractFileSystem';
import { recursiveReadDirectory } from '../context-utils';
import { isAttr, isValuedHtmlAttribute } from '../checks/utils';
import { visit } from '../visitor';

/** Use postcss to extract CSS class names from a CSS string. */
export function extractCSSClassNames(css: string): Set<string> {
  const classNames = new Set<string>();

  try {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      const classRegex = /\.(-?[a-zA-Z_][\w-]*)/g;
      let match;
      while ((match = classRegex.exec(rule.selector)) !== null) {
        classNames.add(match[1]);
      }
    });
  } catch {
    // If CSS fails to parse, assume no classes are defined
  }

  return classNames;
}

// Cache parsed CSS classes per URI to avoid re-reading and re-parsing the same liquid file.
const liquidUriClassesCache = new Map<string, Promise<Set<string>>>();

/** Read a Liquid file and extract CSS class names from its {% stylesheet %} tags. */
export async function extractCSSClassesFromLiquidUri(
  uri: string,
  fs: AbstractFileSystem,
): Promise<Set<string>> {
  const cached = liquidUriClassesCache.get(uri);
  if (cached) return cached;

  const promise = (async () => {
    const classes = new Set<string>();
    try {
      const source = await fs.readFile(uri);
      const ast = toLiquidHtmlAST(source);
      if (ast instanceof Error) return classes;
      const cssStrings = visit<SourceCodeType.LiquidHtml, string>(ast, {
        LiquidRawTag(node: LiquidRawTag) {
          if (node.name === 'stylesheet') {
            return node.body.value;
          }
        },
      });
      for (const css of cssStrings) {
        for (const cls of extractCSSClassNames(css)) {
          classes.add(cls);
        }
      }
    } catch {
      // File not found or parse error — skip
    }
    return classes;
  })();

  liquidUriClassesCache.set(uri, promise);
  return promise;
}

/** Clear the liquid URI classes cache. Exported for testing. */
export function clearLiquidUriClassesCache(): void {
  liquidUriClassesCache.clear();
}

/** Read a CSS asset file and extract class names from it. */
export async function extractCSSClassesFromAssetUri(
  uri: string,
  fs: AbstractFileSystem,
): Promise<Set<string>> {
  try {
    const source = await fs.readFile(uri);
    return extractCSSClassNames(source);
  } catch {
    return new Set();
  }
}

/** Collect all CSS class names from all .css files in the assets directory. */
export async function extractCSSClassesFromAssets(
  fs: AbstractFileSystem,
  toUri: (relativePath: string) => string,
): Promise<Set<string>> {
  const classes = new Set<string>();
  try {
    const assetsUri = toUri('assets');
    const files = await fs.readDirectory(assetsUri);
    const cssFiles = files.filter(([uri]) => uri.endsWith('.css'));
    const results = await Promise.all(
      cssFiles.map(([uri]) => extractCSSClassesFromAssetUri(uri, fs)),
    );
    for (const fileClasses of results) {
      for (const cls of fileClasses) {
        classes.add(cls);
      }
    }
  } catch {
    // assets directory might not exist
  }
  return classes;
}

/** Collect ALL CSS classes defined anywhere in the theme (all liquid stylesheet tags + CSS assets). */
export async function extractAllThemeCSSClasses(
  fs: AbstractFileSystem,
  toUri: (relativePath: string) => string,
): Promise<Set<string>> {
  const allClasses = new Set<string>();

  // Collect from CSS asset files
  const assetClasses = await extractCSSClassesFromAssets(fs, toUri);
  for (const cls of assetClasses) allClasses.add(cls);

  // Collect from all liquid files' stylesheet tags
  try {
    const rootUri = toUri('');
    const liquidFiles = await recursiveReadDirectory(fs, rootUri, ([uri]) =>
      uri.endsWith('.liquid'),
    );
    const results = await Promise.all(
      liquidFiles.map((uri) => extractCSSClassesFromLiquidUri(uri, fs)),
    );
    for (const classes of results) {
      for (const cls of classes) allClasses.add(cls);
    }
  } catch {
    // root directory read failure
  }

  return allClasses;
}

/** Extract used class names from an HTML element's class attribute. */
export function collectUsedClasses(
  attributes: AttributeNode[],
  usedClasses: { className: string; startIndex: number; endIndex: number }[],
): void {
  for (const attr of attributes) {
    if (!isValuedHtmlAttribute(attr) || !isAttr(attr, 'class')) continue;

    for (const valueNode of attr.value) {
      if (valueNode.type !== NodeTypes.TextNode) continue;
      const textNode = valueNode as TextNode;
      const value = textNode.value;
      const baseOffset = textNode.position.start;
      const regex = /\S+/g;
      let match;
      while ((match = regex.exec(value)) !== null) {
        usedClasses.push({
          className: match[0],
          startIndex: baseOffset + match.index,
          endIndex: baseOffset + match.index + match[0].length,
        });
      }
    }
  }
}
