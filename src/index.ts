import { Project, Node, SyntaxKind, ts, SourceFile, CompilerOptions, StringLiteral } from 'ts-morph';
import cliProgress from 'cli-progress';
import { camelCase } from 'string-ts';

import { getResolvedFileName, getTsConfig, trimQuotes } from './helpers';

export const getFileName = (str: string) => {
  const index = str.lastIndexOf('.');
  return str.slice(0, index);
};

type Config = {
  projectFiles: string;
};

type FileUsageMap = Record<string, Record<string, StringLiteral>>;

const getFileUsageMap = (sourceFiles: SourceFile[]) => {
  const filesImports: FileUsageMap = {};
  const tsConfig = getTsConfig();

  const bar0 = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar0.start(sourceFiles.length - 1, 0);

  if (tsConfig) {
    sourceFiles.forEach((sourceFile, index) => {
      const filePath = sourceFile.getFilePath();

      const imports = sourceFile.getImportStringLiterals();
      imports.forEach((literal) => {
        const literalText = trimQuotes(literal.getText());
        const resolvedFileName = getResolvedFileName(literalText, filePath, tsConfig.options);
        if (resolvedFileName && !resolvedFileName.includes('node_modules')) {
          if (filesImports[resolvedFileName]) {
            filesImports[resolvedFileName] = {
              ...filesImports[resolvedFileName],
              [filePath]: literal,
            };
          } else {
            filesImports[resolvedFileName] = { [filePath]: literal };
          }
        }
      });
      bar0.update(index);
    });
    bar0.stop();
  }

  return filesImports;
};

type FileExportNamesMap = Record<
  string,
  {
    usage: string[];
    isDefault: boolean;
  }
>;

const migrateAndGetFileExportNamesMap = (sourceFiles: SourceFile[]) => {
  const exportMap: FileExportNamesMap = {};
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    exportMap[filePath] = {
      isDefault: false,
      usage: [],
    };
    const exportInFile: string[] = [];

    if (['src/sagas/config/index.js'].some((path) => filePath.includes(path))) {
      continue;
    }

    sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).forEach((node) => {
      if (node.getFullText().trim() === 'module.exports') {
        const parent = node.getParent();

        // module.exports.sum = sum;
        if (Node.isPropertyAccessExpression(parent)) {
          exportMap[filePath].isDefault = false;
          const parentOfProp = parent.getParent();
          if (Node.isBinaryExpression(parentOfProp)) {
            const exportedName = parentOfProp.getRight().getFullText().trim();
            exportInFile.push(exportedName);
            const parentOfBinaryExpr = parentOfProp.getParent();
            if (Node.isExpressionStatement(parentOfBinaryExpr)) {
              return parentOfBinaryExpr.remove();
            }
          }
        }

        if (Node.isBinaryExpression(parent)) {
          exportMap[filePath].isDefault = true;
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
                    exportInFile.push(property.getText());
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
                exportInFile.push(camelCasedName);
                return parentOfBinaryExpr.remove();
              }
            }

            // module.exports = sum;
            if (Node.isIdentifier(rightSide)) {
              exportInFile.push(rightSide.getText());
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

    if (exportInFile.length) {
      exportMap[filePath].usage = exportInFile;
    }

    sourceFile.forEachChild((node) => {
      if (Node.isVariableStatement(node)) {
        exportInFile.forEach((exportName) => {
          for (const declarations of node.getDeclarations()) {
            const varName = declarations.getName();
            if (exportName === varName) {
              node.setIsExported(true);
            }
          }
        });
      }
    });
  }

  return Object.keys(exportMap)
    .filter((key) => Boolean(exportMap[key].usage.length))
    .reduce((cur, key) => {
      return Object.assign(cur, { [key]: exportMap[key] });
    }, {});
};

const checkAndFixImport = ({
  project,
  fileUsageMap,
  fileExportNamesMap,
}: {
  project: Project;
  fileUsageMap: FileUsageMap;
  fileExportNamesMap: FileExportNamesMap;
}) => {
  for (const fileUsageMapKey in fileUsageMap) {
    if (fileExportNamesMap[fileUsageMapKey]) {
      for (const fileImportKeyElement in fileUsageMap[fileUsageMapKey]) {
        const personFile = project.getSourceFile(fileImportKeyElement);
        if (personFile) {
          const node = fileUsageMap[fileUsageMapKey][fileImportKeyElement];
          if (node) {
            const parent = node.getParent();
            if (Node.isImportDeclaration(parent)) {
              const importClause = parent.getImportClause();
              if (importClause) {
                const namedBindings = importClause.getNamedBindings();

                // import { sum } from './sum';
                if (Node.isNamedImports(namedBindings)) {
                  const namedImports = importClause.getNamedImports();
                  const namedImportsText = namedImports.map((namedImport) => namedImport.getText());
                  const isImportsIncluded = namedImportsText.every((importText) =>
                    fileExportNamesMap[fileUsageMapKey].usage.includes(importText),
                  );
                  if (isImportsIncluded) {
                    console.log('all imports included');
                  }
                }

                // import * as actions from './subscriptions';
                if (Node.isNamespaceImport(namedBindings)) {
                  const aliasName = namedBindings.getName();
                  if (fileExportNamesMap[fileUsageMapKey] && fileExportNamesMap[fileUsageMapKey].usage.length === 1) {
                    namedBindings.replaceWithText(
                      `{ ${fileExportNamesMap[fileUsageMapKey].usage[0]} as ${aliasName} }`,
                    );
                  }
                }

                // import subtract from './subtract';
                if (namedBindings === undefined) {
                  if (fileExportNamesMap[fileUsageMapKey]) {
                    const importName = importClause.getText();
                    if (fileExportNamesMap[fileUsageMapKey].isDefault) {
                      const exportedName = fileExportNamesMap[fileUsageMapKey].usage[0];
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
        }
      }
    }
  }
};

export const migrate = (config: Config) => {
  const project = new Project({
    tsConfigFilePath: 'tsconfig.json',
  });

  const sourceFiles = project.getSourceFiles(config.projectFiles);

  const fileUsageMap = getFileUsageMap(sourceFiles);
  const fileExportNamesMap = migrateAndGetFileExportNamesMap(sourceFiles);

  checkAndFixImport({
    project,
    fileUsageMap,
    fileExportNamesMap,
  });

  return project.save();
};

// migrate({
//   projectFiles: 'src/**/*.{tsx,ts,js}',
// });

// migrate({
//   projectFiles: 'test/test-project/case8/*.{tsx,ts,js}',
// });
