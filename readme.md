# cjs2mjsExport

## Related projects

Other projects makes changes file by file instead of fix usage of export from this file

[wessberg/cjstoesm: A tool that can transform CommonJS to ESM](https://github.com/wessberg/cjstoesm) - produce a lot of changes

[5to6/5to6-codemod: A collection of codemods that allow you to transform your js code from ES5 to ES6.](https://github.com/5to6/5to6-codemod)

[azu/commonjs-to-es-module-codemod: Codemod that convert CommonJS(require/exports) to ES Modules(import/export) for JavaScript/TypeScript](https://github.com/azu/commonjs-to-es-module-codemod)

Issue on typescript which can help handle this: [Support find-all-references for module.exports · Issue #22205 · microsoft/TypeScript](https://github.com/microsoft/TypeScript/issues/22205)


## TODO

- [x] handle `module.exports.sum`  with `import { sum } from './sum';` will be transformed to `export const sum`
- [ ] handle `module.exports.sum`  with `import tool from './sum';` will be transformed to `export const sum` and `import * tool from './sum';`
- [x] handle `module.exports = sum`  with `import sum from './sum';` will be transformed to `export const sum` and `import { sum } from './sum';`
- [x] `module.exports = { name: 'name'}` need to be transformed to `export const [fileName] = {`
- [x] `module.exports = {name}` need to be transformed to `export const name = 'name'`
