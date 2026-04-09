import {
  LiquidRawTag,
  HtmlElement,
  HtmlVoidElement,
  HtmlSelfClosingElement,
} from '@shopify/liquid-html-parser';
import { LiquidCheckDefinition, Severity, SourceCodeType } from '../../types';
import { AbstractFileSystem } from '../../AbstractFileSystem';
import {
  extractCSSClassNames,
  extractCSSClassesFromLiquidUri,
  extractCSSClassesFromAssets,
  extractAllThemeCSSClasses,
  collectUsedClasses,
} from '../../utils/styles';
import {
  getAncestorUris,
  getAllSnippetDescendantUris,
  getRenderedSnippetUris,
} from '../../utils/traversal';

// Cache expensive theme-wide computations per fs instance so they run once per check run, not per file.
// WeakMap ensures the cache is garbage-collected when the fs instance is no longer referenced.
const allThemeClassesCache = new WeakMap<AbstractFileSystem, Promise<Set<string>>>();
const assetClassesCache = new WeakMap<AbstractFileSystem, Promise<Set<string>>>();

export const ValidCSSClassWithinStylesheet: LiquidCheckDefinition = {
  meta: {
    code: 'ValidCSSClassWithinStylesheet',
    name: 'Validates CSS classes used in class attributes are defined in an in-scope stylesheet',
    docs: {
      description:
        'Reports CSS classes used in HTML class attributes that are not defined in any in-scope stylesheet tag or CSS asset file.',
      recommended: true,
      url: 'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/valid-css-class-within-stylesheet',
    },
    type: SourceCodeType.LiquidHtml,
    severity: Severity.WARNING,
    schema: {},
    targets: [],
  },

  create(context) {
    const localCSSClasses = new Set<string>();
    const usedClasses: { className: string; startIndex: number; endIndex: number }[] = [];

    return {
      async LiquidRawTag(node: LiquidRawTag) {
        if (node.name === 'stylesheet') {
          for (const cls of extractCSSClassNames(node.body.value)) {
            localCSSClasses.add(cls);
          }
        }
      },

      async HtmlElement(node: HtmlElement) {
        collectUsedClasses(node.attributes, usedClasses);
      },

      async HtmlVoidElement(node: HtmlVoidElement) {
        collectUsedClasses(node.attributes, usedClasses);
      },

      async HtmlSelfClosingElement(node: HtmlSelfClosingElement) {
        collectUsedClasses(node.attributes, usedClasses);
      },

      async onCodePathEnd() {
        if (usedClasses.length === 0) return;

        const { getReferences, getDependencies, fs, toUri } = context;
        if (!getReferences || !getDependencies) return;

        // Start with local CSS classes
        const inScopeClasses = new Set(localCSSClasses);

        // 1. Extract CSS classes from all .css files in the assets folder (cached per fs instance)
        if (!assetClassesCache.has(fs)) {
          assetClassesCache.set(fs, extractCSSClassesFromAssets(fs, toUri));
        }
        const assetClasses = await assetClassesCache.get(fs)!;
        for (const cls of assetClasses) {
          inScopeClasses.add(cls);
        }

        // 2. Get all ancestors (following direct references upward)
        const ancestors = await getAncestorUris(context.file.uri, getReferences);

        // 3. Extract CSS classes from ancestor stylesheet tags
        const ancestorClassResults = await Promise.all(
          ancestors.map((uri) => extractCSSClassesFromLiquidUri(uri, fs)),
        );
        for (const classes of ancestorClassResults) {
          for (const cls of classes) inScopeClasses.add(cls);
        }

        // 4. Collect rendered snippets from this file and all ancestors
        const filesToCheck = [context.file.uri, ...ancestors];
        const allRenderedSnippetUris: string[] = [];
        for (const fileUri of filesToCheck) {
          const snippetUris = await getRenderedSnippetUris(fileUri, getDependencies);
          allRenderedSnippetUris.push(...snippetUris);
        }

        // 5. BFS through snippet descendants to find all reachable snippets
        const allSnippetUris = await getAllSnippetDescendantUris(
          allRenderedSnippetUris,
          getDependencies,
        );

        // 6. Extract CSS classes from all reachable snippet stylesheet tags
        const snippetClassResults = await Promise.all(
          allSnippetUris.map((uri) => extractCSSClassesFromLiquidUri(uri, fs)),
        );
        for (const classes of snippetClassResults) {
          for (const cls of classes) inScopeClasses.add(cls);
        }

        // 7. Collect ALL CSS classes defined anywhere in the theme (cached per fs instance)
        if (!allThemeClassesCache.has(fs)) {
          allThemeClassesCache.set(fs, extractAllThemeCSSClasses(fs, toUri));
        }
        const allThemeClasses = await allThemeClassesCache.get(fs)!;

        // 8. Only report classes that ARE defined somewhere in the theme but not in scope.
        //    Classes not defined anywhere (e.g. from CDNs, utility frameworks) are silently ignored.
        for (const { className, startIndex, endIndex } of usedClasses) {
          if (allThemeClasses.has(className) && !inScopeClasses.has(className)) {
            context.report({
              message: `CSS class '${className}' may be defined outside the scope of this file.`,
              startIndex,
              endIndex,
            });
          }
        }
      },
    };
  },
};
