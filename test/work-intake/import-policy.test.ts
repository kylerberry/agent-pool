import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoModuleReferencePrefixes,
  assertNoModuleReferences,
  assertOnlyModuleReferencePrefixes,
  assertOnlyModuleReferences,
  staticModuleReferences,
} from '../helpers/import-policy.ts';

function fixture(source: string): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'import-policy-'));
  const path = join(root, 'fixture.ts');
  writeFileSync(path, source);
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('import policy helper', () => {
  it('finds static module references while ignoring comments', () => {
    const file = fixture(`
      // import 'forbidden-comment';
      import value from 'ordinary-import';
      import type { TypeOnly } from 'type-only-import';
      export { value as exported } from 're-export';
      import equals = require('import-equals');
      const required = require('required-module');
      const loaded = import('dynamic-module');
    `);
    try {
      assert.deepEqual(
        staticModuleReferences(file.path).map(({ specifier, kind }) => ({ specifier, kind })),
        [
          { specifier: 'ordinary-import', kind: 'import' },
          { specifier: 'type-only-import', kind: 'import' },
          { specifier: 're-export', kind: 'export-from' },
          { specifier: 'import-equals', kind: 'import-equals' },
          { specifier: 'required-module', kind: 'require' },
          { specifier: 'dynamic-module', kind: 'dynamic-import' },
        ],
      );
      assert.doesNotThrow(() => assertNoModuleReferences(file.path, ['forbidden-comment']));
      assert.doesNotThrow(() => assertOnlyModuleReferences(file.path, [
        'ordinary-import', 'type-only-import', 're-export', 'import-equals', 'required-module', 'dynamic-module',
      ]));
    } finally {
      file.cleanup();
    }
  });

  it('fails closed for computed module references', () => {
    const file = fixture("const loaded = import(moduleName);\n");
    try {
      assert.throws(
        () => assertNoModuleReferences(file.path, ['forbidden-module']),
        new RegExp(`${file.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1:23: computed dynamic-import specifier <computed>`),
      );
    } finally {
      file.cleanup();
    }
  });

  it('applies slash-terminated prefixes to deny and allow policies', () => {
    const file = fixture("import '../orchestration/controller.ts';\nimport '../orchestration-extra/index.ts';\nimport './local.ts';\n");
    try {
      assert.throws(() => assertNoModuleReferencePrefixes(file.path, ['../orchestration/']), /controller\.ts/);
      assert.doesNotThrow(() => assertOnlyModuleReferencePrefixes(file.path, ['../orchestration/', '../orchestration-extra/', './']));
      assert.throws(() => assertOnlyModuleReferencePrefixes(file.path, ['../orchestration-extra/', './']), /controller\.ts/);
      assert.throws(() => assertNoModuleReferencePrefixes(file.path, ['../orchestration']), /must end with/);
    } finally {
      file.cleanup();
    }
  });
});
