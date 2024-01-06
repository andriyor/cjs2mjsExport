import { Project, Node, SyntaxKind, ts, SourceFile, CompilerOptions, StringLiteral } from 'ts-morph';
import cliProgress from 'cli-progress';
import { camelCase } from 'string-ts';
import { typeFlag } from 'type-flag';

const parsed = typeFlag({
  projectFiles: {
    type: String,
    alias: 'f',
  },
});

import { getResolvedFileName, getTsConfig, trimQuotes } from './helpers';

export const getFileName = (str: string) => {
  const index = str.lastIndexOf('.');
  return str.slice(0, index);
};

type Config = {
  projectFiles: string;
};

type FileUsagesMap = Record<string, Record<string, StringLiteral>>;

const getAllFilesUsagesMap = (sourceFiles: SourceFile[]) => {
  const fileUsages: FileUsagesMap = {};
  const tsConfig = getTsConfig();

  console.log('Scan all files imports');
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(sourceFiles.length - 1, 0);

  if (tsConfig) {
    sourceFiles.forEach((sourceFile, index) => {
      const filePath = sourceFile.getFilePath();

      const importStringLiterals = sourceFile.getImportStringLiterals();
      importStringLiterals.forEach((importStringLiteral) => {
        const literalText = trimQuotes(importStringLiteral.getText());
        const importFilePath = getResolvedFileName(literalText, filePath, tsConfig.options);
        if (importFilePath && !importFilePath.includes('node_modules')) {
          if (fileUsages[importFilePath]) {
            fileUsages[importFilePath] = {
              ...fileUsages[importFilePath],
              [filePath]: importStringLiteral,
            };
          } else {
            fileUsages[importFilePath] = { [filePath]: importStringLiteral };
          }
        }
      });
      bar.update(index);
    });
    bar.stop();
  }

  return fileUsages;
};

type FileExportNamesMap = Record<
  string,
  {
    exportedVarFromFile: string[];
    isFileUseDefaultExport: boolean;
  }
>;

const migrateAndGetFileExportNamesMap = (sourceFiles: SourceFile[]) => {
  const exportMap: FileExportNamesMap = {};

  console.log('Change CJS export to ESM export');
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(sourceFiles.length - 1, 0);

  sourceFiles.forEach((sourceFile, index) => {
    const filePath = sourceFile.getFilePath();
    exportMap[filePath] = {
      isFileUseDefaultExport: false,
      exportedVarFromFile: [],
    };
    const exportedVarFromFile: string[] = [];

    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach((node) => {
      if (node.getFullText().trim() === 'module.exports') {
        const parent = node.getParent();

        // module.exports.sum = sum;
        if (Node.isPropertyAccessExpression(parent)) {
          exportMap[filePath].isFileUseDefaultExport = false;
          const parentOfProp = parent.getParent();
          if (Node.isBinaryExpression(parentOfProp)) {
            const right = parentOfProp.getRight();
            if (!Node.isFunctionExpression(right)) {
              const exportedName = parentOfProp.getRight().getFullText().trim();
              exportedVarFromFile.push(exportedName);
              const parentOfBinaryExpr = parentOfProp.getParent();
              if (Node.isExpressionStatement(parentOfBinaryExpr)) {
                return parentOfBinaryExpr.remove();
              }
            }
          }
        }

        if (Node.isBinaryExpression(parent)) {
          exportMap[filePath].isFileUseDefaultExport = true;
          const parentOfBinaryExpr = parent.getParent();
          if (Node.isExpressionStatement(parentOfBinaryExpr)) {
            const rightSide = parent.getRight();

            // module.exports = {
            if (Node.isObjectLiteralExpression(rightSide)) {
              const properties = rightSide.getProperties();
              const isAllShorthand = properties.every((property) => Node.isShorthandPropertyAssignment(property));
              if (isAllShorthand) {
                // module.exports = {sum}
                for (const property of properties) {
                  if (Node.isShorthandPropertyAssignment(property)) {
                    exportedVarFromFile.push(property.getText());
                    const referencedSymbols = property.findReferences();

                    for (const referencedSymbol of referencedSymbols) {
                      for (const reference of referencedSymbol.getReferences()) {
                        const parent = reference.getNode().getParentOrThrow().getParentOrThrow().getParentOrThrow();
                        if (Node.isVariableStatement(parent)) {
                          parent.setIsExported(true);
                        }
                      }
                    }
                  }
                }
                return parentOfBinaryExpr.remove();
              } else {
                // module.exports = {sum: 'some'}
                const extText = rightSide.getFullText().trim();
                const fileName = getFileName(sourceFile.getBaseName());
                const camelCasedName = camelCase(fileName);
                sourceFile.insertStatements(0, `export const ${camelCasedName} = ${extText}`);
                exportedVarFromFile.push(camelCasedName);
                return parentOfBinaryExpr.remove();
              }
            }

            // module.exports = sum;
            if (Node.isIdentifier(rightSide)) {
              exportedVarFromFile.push(rightSide.getText());
              const referencedSymbols = rightSide.findReferences();

              for (const referencedSymbol of referencedSymbols) {
                for (const reference of referencedSymbol.getReferences()) {
                  const parent = reference.getNode().getParentOrThrow().getParentOrThrow().getParentOrThrow();
                  if (Node.isVariableStatement(parent)) {
                    parent.setIsExported(true);
                    return parentOfBinaryExpr.remove();
                  }
                }
              }
            }
          }
        }
      }
    });

    if (exportedVarFromFile.length) {
      exportMap[filePath].exportedVarFromFile = exportedVarFromFile;
    }

    sourceFile.getChildrenOfKind(SyntaxKind.VariableStatement).forEach((variableStatement) => {
      exportedVarFromFile.forEach((exportName) => {
        for (const declarations of variableStatement.getDeclarations()) {
          const varName = declarations.getName();
          if (exportName === varName) {
            variableStatement.setIsExported(true);
          }
        }
      });
    });
    bar.update(index);
  });

  bar.stop();
  // remove paths which doesn't have cjs export
  return Object.keys(exportMap)
    .filter((key) => Boolean(exportMap[key].exportedVarFromFile.length))
    .reduce((cur, key) => {
      return Object.assign(cur, { [key]: exportMap[key] });
    }, {});
};

const fixFilesImports = ({
  allFilesUsagesMap,
  fileCJSExportNamesMap,
}: {
  allFilesUsagesMap: FileUsagesMap;
  fileCJSExportNamesMap: FileExportNamesMap;
}) => {
  const fileUsageMapKeys = Object.keys(allFilesUsagesMap);
  console.log('Fix file imports');
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(fileUsageMapKeys.length - 1, 0);

  fileUsageMapKeys.forEach((fileUsageMapKey, index) => {
    if (fileCJSExportNamesMap[fileUsageMapKey]) {
      for (const fileImportKeyElement in allFilesUsagesMap[fileUsageMapKey]) {
        const node = allFilesUsagesMap[fileUsageMapKey][fileImportKeyElement];
        const parent = node.getParent();
        if (Node.isImportDeclaration(parent)) {
          const importClause = parent.getImportClauseOrThrow();
          const namedBindings = importClause.getNamedBindings();

          // import * as actions from './subscriptions';
          if (Node.isNamespaceImport(namedBindings)) {
            const aliasName = namedBindings.getName();
            if (
              fileCJSExportNamesMap[fileUsageMapKey] &&
              fileCJSExportNamesMap[fileUsageMapKey].exportedVarFromFile.length === 1
            ) {
              namedBindings.replaceWithText(
                `{ ${fileCJSExportNamesMap[fileUsageMapKey].exportedVarFromFile[0]} as ${aliasName} }`,
              );
            }
          }

          // import subtract from './subtract';
          if (namedBindings === undefined) {
            if (fileCJSExportNamesMap[fileUsageMapKey]) {
              const importName = importClause.getText();
              if (fileCJSExportNamesMap[fileUsageMapKey].isFileUseDefaultExport) {
                const exportedName = fileCJSExportNamesMap[fileUsageMapKey].exportedVarFromFile[0];
                if (exportedName === importName) {
                  importClause.replaceWithText(`{ ${exportedName} }`);
                } else {
                  importClause.replaceWithText(`{ ${exportedName} as ${importName} }`);
                }
              } else {
                importClause.replaceWithText(`* as ${importName}`);
              }
            }
          }
        }
      }
    }
    bar.update(index);
  });
  bar.stop();
};

export const migrate = (config: Config) => {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const sourceFiles = project.getSourceFiles(config.projectFiles);

  const allFilesUsagesMap = getAllFilesUsagesMap(sourceFiles);
  const fileCJSExportNamesMap = migrateAndGetFileExportNamesMap(sourceFiles);

  fixFilesImports({
    allFilesUsagesMap,
    fileCJSExportNamesMap,
  });

  return project.save();
};

if (parsed.flags.projectFiles) {
  migrate({
    projectFiles: parsed.flags.projectFiles,
  });
} else {
  console.log('provide --project-files option');
}
