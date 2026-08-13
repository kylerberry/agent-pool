import { readFileSync } from 'node:fs';
import ts from 'typescript';

export type ModuleReference = Readonly<{
  specifier: string;
  kind: 'import' | 'export-from' | 'import-equals' | 'require' | 'dynamic-import';
  line: number;
  column: number;
}>;

type ScanResult = {
  readonly references: readonly ModuleReference[];
  readonly computedReferences: readonly Readonly<{ kind: 'require' | 'dynamic-import'; line: number; column: number }>[];
};

function location(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function scan(filePath: string): ScanResult {
  const text = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references: ModuleReference[] = [];
  const computedReferences: Array<{ kind: 'require' | 'dynamic-import'; line: number; column: number }> = [];

  const add = (specifier: string, kind: ModuleReference['kind'], node: ts.Node): void => {
    references.push({ specifier, kind, ...location(sourceFile, node) });
  };
  const noteComputed = (kind: 'require' | 'dynamic-import', node: ts.Node): void => {
    computedReferences.push({ kind, ...location(sourceFile, node) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, 'import', node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, 'export-from', node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) add(expression.text, 'import-equals', expression);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const kind = isRequire ? 'require' : 'dynamic-import';
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteral(argument)) add(argument.text, kind, argument);
        else noteComputed(kind, argument ?? node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { references, computedReferences };
}

export function staticModuleReferences(filePath: string): readonly ModuleReference[] {
  return scan(filePath).references;
}

function assertNoComputedReferences(filePath: string, computedReferences: ScanResult['computedReferences']): void {
  if (computedReferences.length === 0) return;
  const details = computedReferences
    .map((reference) => `${filePath}:${reference.line}:${reference.column}: computed ${reference.kind} specifier <computed> cannot be checked`)
    .join('\n');
  throw new Error(`Import policy cannot evaluate computed module references:\n${details}`);
}

function assertSafePrefixes(prefixes: readonly string[]): void {
  for (const prefix of prefixes) {
    if (!prefix.endsWith('/') && prefix !== 'node:') throw new Error(`Module reference prefix must end with /: ${prefix}`);
  }
}

function assertReferences(
  filePath: string,
  references: readonly ModuleReference[],
  label: string,
): void {
  if (references.length === 0) return;
  throw new Error(
    `${label}:\n${references
      .map((reference) => `${filePath}:${reference.line}:${reference.column}: ${reference.kind} ${reference.specifier}`)
      .join('\n')}`,
  );
}

export function assertNoModuleReferences(filePath: string, forbidden: readonly string[]): void {
  const result = scan(filePath);
  assertNoComputedReferences(filePath, result.computedReferences);
  assertReferences(filePath, result.references.filter((reference) => forbidden.includes(reference.specifier)), 'Forbidden module references');
}

/** Denies every literal specifier under one of the safe prefixes. */
export function assertNoModuleReferencePrefixes(filePath: string, forbiddenPrefixes: readonly string[]): void {
  assertSafePrefixes(forbiddenPrefixes);
  const result = scan(filePath);
  assertNoComputedReferences(filePath, result.computedReferences);
  assertReferences(filePath, result.references.filter((reference) => forbiddenPrefixes.some((prefix) => reference.specifier.startsWith(prefix))), 'Forbidden module references');
}

export function assertOnlyModuleReferences(filePath: string, allowed: readonly string[]): void {
  const result = scan(filePath);
  assertNoComputedReferences(filePath, result.computedReferences);
  assertReferences(filePath, result.references.filter((reference) => !allowed.includes(reference.specifier)), 'Unexpected module references');
}

/** Allows only literal specifiers under one of the safe prefixes. */
export function assertOnlyModuleReferencePrefixes(filePath: string, allowedPrefixes: readonly string[]): void {
  assertSafePrefixes(allowedPrefixes);
  const result = scan(filePath);
  assertNoComputedReferences(filePath, result.computedReferences);
  assertReferences(filePath, result.references.filter((reference) => !allowedPrefixes.some((prefix) => reference.specifier.startsWith(prefix))), 'Unexpected module references');
}
