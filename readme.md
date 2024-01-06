# cjs2mjsExport

A tool that can transform CommonJS to ESM

## CLI

```shell
tsx [pathToLibrary]/cjs2mjsExport/src/index.ts --project-files='src/**/*.{tsx,ts,js}'
```

## API

```ts
import { migrate } from './src/index.ts';

migrate({
  projectFiles: 'src/**/*.{tsx,ts,js}',
})
```

## Related projects

Other projects makes changes file by file instead of fix usage of export from this file and doesn't change ESM import of CJS module

[wessberg/cjstoesm: A tool that can transform CommonJS to ESM](https://github.com/wessberg/cjstoesm) - produce a lot of changes and slow

have several issues:

 - [Doesn't work with newer TypeScript versions · Issue #34 · wessberg/cjstoesm](https://github.com/wessberg/cjstoesm/issues/34) because typescript have a lot of braking changes in compiler api and this package it relies on typescript package used by project   
 - [Usage documentation is unclear · Issue #27 · wessberg/cjstoesm](https://github.com/wessberg/cjstoesm/issues/27)


[5to6/5to6-codemod: A collection of codemods that allow you to transform your js code from ES5 to ES6.](https://github.com/5to6/5to6-codemod)

[azu/commonjs-to-es-module-codemod: Codemod that convert CommonJS(require/exports) to ES Modules(import/export) for JavaScript/TypeScript](https://github.com/azu/commonjs-to-es-module-codemod)


## TODO

- [x] run as cli
- [x] progress bar
- [x] handle `module.exports.sum`  with `import { sum } from './sum';` will be transformed to `export const sum`
- [x] handle `module.exports.sum`  with `import tool from './sum';` will be transformed to `export const sum` and `import * tool from './sum';`
- [x] handle `module.exports = sum`  with `import sum from './sum';` will be transformed to `export const sum` and `import { sum } from './sum';`
- [x] `module.exports = { name: 'name'}` need to be transformed to `export const [fileName] = {`
- [x] `module.exports = {name}` need to be transformed to `export const name = 'name'`
- [ ] handle `module.exports = {name: 'name'}` with `import { name } from './module';`
- [ ] handle `module.exports.sum = function sum(a, b) {`
- [ ] publish package

## References

Issue on typescript which can help handle this: [Support find-all-references for module.exports · Issue #22205 · microsoft/TypeScript](https://github.com/microsoft/TypeScript/issues/22205)
